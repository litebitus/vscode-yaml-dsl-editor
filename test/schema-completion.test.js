const test = require('node:test');
const assert = require('node:assert/strict');
const { schemaCompletionsAt, schemaHintAt } = require('../lib/schema-completion');

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: {
    mocktype: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string', description: 'The mock label.' },
        mode: { enum: ['fast', 'slow'], description: '[optional] The mock mode.' },
        enabled: { type: 'boolean', description: '[optional] Whether the mock is on.' },
        tags: { type: 'array', items: { enum: ['mock-a', 'mock-b'] }, description: '[optional] The mock tags.' },
        settings: { $ref: '#/$defs/settings', description: '[~required] The mock settings.' },
        legacy: { type: 'string', deprecated: true, description: '[optional] Use mode.' },
        size: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^ref ' }] },
      },
    },
  },
  $defs: { settings: { type: 'object', properties: { depth: { type: 'integer' } } } },
};

function completionsAfter(text) {
  const lines = text.split('\n');
  const position = { line: lines.length - 1, character: lines[lines.length - 1].length };
  return schemaCompletionsAt(text, position, schema);
}

const byLabel = (items) => Object.fromEntries(items.map((item) => [item.label, item]));

test('a key position offers the schema\'s fields, each with its marker, description and insertion', () => {
  const items = byLabel(completionsAfter('mocktype:\n  label: mock\n  se'));
  assert.deepEqual(Object.keys(items).sort(), ['enabled', 'label', 'legacy', 'mode', 'settings', 'size', 'tags']);
  assert.deepEqual(items.settings.range, { start: { line: 2, character: 2 }, end: { line: 2, character: 4 } });
  assert.deepEqual([items.settings.detail, items.settings.documentation], ['[~required]', 'The mock settings.']);
  assert.equal(items.settings.labelDescription, '[~required] The mock settings.');
  assert.equal(items.size.labelDescription, '[optional]');
  assert.equal(items.settings.insertText, 'settings:\n    ');
  assert.equal(items.tags.insertText, 'tags:\n    ');
  assert.deepEqual([items.mode.insertText, items.mode.suggestsValues], ['mode: ', true]);
  assert.deepEqual([items.size.insertText, items.size.suggestsValues], ['size: ', false]);
  assert.deepEqual([items.legacy.deprecated, items.mode.deprecated], [true, false]);
});

test('a scalar field with a default inserts the default selected, opening no value list', () => {
  const defaultSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      mocktype: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', default: false },
          retention: { $ref: '#/$defs/retention' },
          tags: { type: 'array', default: ['mock-tag'] },
        },
      },
    },
    $defs: { retention: { type: 'integer', default: 4 } },
  };
  const position = { line: 1, character: 2 };
  const items = byLabel(schemaCompletionsAt('mocktype:\n  ', position, defaultSchema));
  assert.deepEqual(
    [items.dry_run.insertText, items.dry_run.insertsSnippet, items.dry_run.suggestsValues],
    ['dry_run: ${1:false}', true, false],
  );
  assert.equal(items.retention.insertText, 'retention: ${1:4}');
  assert.deepEqual([items.tags.insertText, items.tags.insertsSnippet], ['tags:\n    ', false]);
});

test('a field a parent requires is marked required', () => {
  const items = byLabel(completionsAfter('mocktype:\n  '));
  assert.deepEqual([items.label.detail, items.mode.detail], ['[required]', '[optional]']);
});

test('a value position offers the field\'s enum values and booleans, replacing what is typed', () => {
  const modes = completionsAfter('mocktype:\n  mode: f');
  assert.deepEqual(modes.map((item) => item.label), ['fast', 'slow']);
  assert.deepEqual(modes[0].range, { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } });
  assert.deepEqual(completionsAfter('mocktype:\n  enabled: ').map((item) => item.label), ['true', 'false']);
  assert.deepEqual(completionsAfter('mocktype:\n  size: ').map((item) => item.label), []);
});

test('a list item offers the item schema\'s values, and the fields of a map item', () => {
  assert.deepEqual(completionsAfter('mocktype:\n  tags:\n    - ').map((item) => item.label), ['mock-a', 'mock-b']);
  assert.deepEqual(completionsAfter('mocktype:\n  settings:\n    ').map((item) => item.label), ['depth']);
});

test('text inside a block scalar, and a schema of a draft the editor does not read, offer nothing', () => {
  assert.deepEqual(completionsAfter('mocktype:\n  label: |\n    se'), []);
  const unread = { ...schema, $schema: 'https://example.com/mock-draft' };
  assert.deepEqual(schemaCompletionsAt('mocktype:\n  ', { line: 1, character: 2 }, unread), []);
  assert.deepEqual(schemaCompletionsAt('mocktype:\n  ', { line: 1, character: 2 }, null), []);
});

test('a key typed in a tagged map is offered the fields of the key its tag stands for', () => {
  const tagged = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      mockvalue: {
        type: 'object',
        properties: { 'Fn::Mock': { type: 'object', properties: { label: { type: 'string' } } } },
      },
    },
  };
  const text = 'mockvalue: !Mock\n  la';
  const position = { line: 1, character: 4 };
  const labelsWith = (tagKeys) => schemaCompletionsAt(text, position, tagged, { tagKeys }).map((item) => item.label);
  assert.deepEqual(labelsWith([{ tag: '!Mock', key: 'Fn::Mock' }]), ['label']);
  assert.deepEqual(labelsWith([]), ['Fn::Mock']);
});

test('a key position reads the schema at the path its place maps to, such as where a loop\'s body lands', () => {
  const text = 'loop:\n  - [x]\n  - body:\n      ';
  const position = { line: 3, character: 6 };
  const landing = (documentPath) => (
    documentPath[0] === 'loop' ? ['mocktype', ...documentPath.slice(3)] : documentPath
  );
  const labels = schemaCompletionsAt(text, position, schema, { schemaPathOf: landing }).map((item) => item.label);
  assert.ok(labels.includes('label'), labels.join(', '));
  assert.deepEqual(schemaCompletionsAt(text, position, schema), []);
});

function openMapCompletions(mockMap, typedLine = '  ') {
  const openSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { mock_map: { description: '[optional] The mock map.', ...mockMap } },
  };
  const text = `mock_map:\n${typedLine}`;
  return schemaCompletionsAt(text, { line: 1, character: typedLine.length }, openSchema);
}

const offered = (items) => items.map((item) => [item.label, item.insertText]);

test('an open key whose values are consts or booleans offers the key placeholder and a choice of the values', () => {
  const consts = openMapCompletions({ type: 'object', additionalProperties: { oneOf: [{ const: 'low' }, { const: 'high' }] } });
  assert.deepEqual(offered(consts), [['<key>: low | high', '${1:<key>}: ${2|low,high|}']]);
  assert.deepEqual([consts[0].documentation, consts[0].labelDescription, consts[0].insertsSnippet], ['The mock map.', '', true]);
  const booleans = openMapCompletions({ type: 'object', additionalProperties: { type: 'boolean' } });
  assert.deepEqual(offered(booleans), [['<key>: true | false', '${1:<key>}: ${2|true,false|}']]);
});

test('an open key whose value is typed offers the type as a placeholder, and several types leave the value empty', () => {
  const integers = openMapCompletions({ type: 'object', additionalProperties: { type: 'integer' } });
  assert.deepEqual(offered(integers), [['<key>: <integer>', '${1:<key>}: ${2:<integer>}']]);
  const mixed = openMapCompletions({ type: 'object', additionalProperties: { type: ['string', 'number'] } });
  assert.deepEqual(offered(mixed), [['<key>: <string> | <number>', '${1:<key>}: $2']]);
  const anything = openMapCompletions({ type: 'object', additionalProperties: true });
  assert.deepEqual(offered(anything), [['<key>:', '${1:<key>}: $2']]);
});

test('an open key whose value is a map or a list opens the value on the next line', () => {
  const maps = openMapCompletions({
    type: 'object',
    additionalProperties: { type: 'object', properties: { mock_size: { type: 'integer' } } },
  });
  assert.deepEqual(offered(maps), [['<key>:', '${1:<key>}:\n    $0']]);
  const strings = openMapCompletions({ type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } });
  assert.deepEqual(offered(strings), [['<key>:', '${1:<key>}:\n    - ${2:<string>}']]);
  const objects = openMapCompletions({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'object', properties: { mock_name: { type: 'string' } } } },
  });
  assert.deepEqual(offered(objects), [['<key>:', '${1:<key>}:\n    - $0']]);
});

test('keys named by propertyNames are offered by name, and keys patternProperties admits are not offered', () => {
  const named = openMapCompletions({
    type: 'object',
    propertyNames: { enum: ['mock-a', 'mock-b'] },
    additionalProperties: { type: 'string' },
  });
  assert.deepEqual(offered(named), [['mock-a: <string>', 'mock-a: ${1:<string>}'], ['mock-b: <string>', 'mock-b: ${1:<string>}']]);
  const patterned = openMapCompletions({ type: 'object', patternProperties: { '^mock-$': { type: 'integer' } } });
  assert.deepEqual(offered(patterned), []);
});

test('a map with named fields and open keys offers both, and a closed map offers its fields alone', () => {
  const both = openMapCompletions({
    type: 'object',
    properties: { mock_fixed: { type: 'string' } },
    additionalProperties: { type: 'boolean' },
  });
  assert.deepEqual(both.map((item) => item.label), ['mock_fixed', '<key>: true | false']);
  const closed = openMapCompletions({ type: 'object', properties: { mock_fixed: { type: 'string' } }, additionalProperties: false });
  assert.deepEqual(closed.map((item) => item.label), ['mock_fixed']);
  const unstated = openMapCompletions({ type: 'object', properties: { mock_fixed: { type: 'string' } } });
  assert.deepEqual(unstated.map((item) => item.label), ['mock_fixed']);
});

test('a value position documents each const value with its own description', () => {
  const values = openMapCompletions({
    type: 'object',
    additionalProperties: { oneOf: [{ const: 'low', description: 'The mock low.' }, { const: 'high' }] },
  }, '  mock-x: ');
  assert.deepEqual(values.map((item) => [item.label, item.documentation]), [['low', 'The mock low.'], ['high', '']]);
  const described = openMapCompletions({
    type: 'object',
    additionalProperties: { description: 'The mock value.', enum: ['low', 'high'] },
  }, '  mock-x: ');
  assert.deepEqual(described.map((item) => [item.label, item.documentation]), [['low', ''], ['high', '']]);
});

function hintAfter(mockMap, typedLine) {
  const hintSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { mock_map: { description: '[optional] The mock map.', ...mockMap } },
  };
  const text = `mock_map:\n${typedLine}`;
  return schemaHintAt(text, { line: 1, character: typedLine.length }, hintSchema);
}

test('the hint at a key shows the shape of each field and open key, with the description of the map holding it', () => {
  const hint = hintAfter({
    type: 'object',
    properties: { mock_fixed: { type: 'string' }, mock_mode: { enum: ['fast', 'slow'] } },
    additionalProperties: { oneOf: [{ const: 'low' }, { const: 'high' }] },
  }, '  ');
  assert.deepEqual(hint, {
    rows: ['mock_fixed: <string>', 'mock_mode: fast | slow', '<key>: low | high'],
    documentation: 'The mock map.',
  });
});

test('the hint at a value lists each value with its own description under the description of its field', () => {
  const hint = hintAfter({
    type: 'object',
    additionalProperties: { oneOf: [{ const: 'low', description: 'The mock low.' }, { const: 'high' }] },
  }, '  mock-x: ');
  assert.deepEqual(hint, {
    rows: ['mock-x: low | high'],
    documentation: 'The mock map.\n\n- `low`: The mock low.\n- `high`',
  });
});

test('the hint at a new list item shows the item\'s fields or its values', () => {
  const mapItems = hintAfter({
    type: 'array',
    items: { type: 'object', description: 'The mock item.', properties: { mock_name: { type: 'string' } } },
  }, '  - ');
  assert.deepEqual(mapItems.rows, ['mock_name: <string>']);
  const scalarItems = hintAfter({ type: 'array', items: { enum: ['mock-a', 'mock-b'] } }, '  - ');
  assert.deepEqual(scalarItems.rows, ['- mock-a | mock-b']);
});

test('a value of no stated shape is hinted by its description alone, and nothing stated gives no hint', () => {
  const described = hintAfter({ type: 'object', additionalProperties: true }, '  mock-x: ');
  assert.deepEqual(described, { rows: ['mock-x:'], documentation: 'The mock map.' });
  assert.equal(hintAfter({ type: 'object' }, '  '), null);
  const undescribed = schemaHintAt('mock_map:\n  mock-x: ', { line: 1, character: 10 }, {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { mock_map: { type: 'object', additionalProperties: true } },
  });
  assert.equal(undescribed, null);
});

test('a key holding brackets after its first character is read as a key, at its key and at its value', () => {
  const mockMap = { type: 'object', additionalProperties: { oneOf: [{ const: 'low' }, { const: 'high' }] } };
  const atKey = openMapCompletions(mockMap, '  $.mock[*].size');
  assert.deepEqual(atKey.map((item) => item.label), ['<key>: low | high']);
  assert.deepEqual(atKey[0].range, { start: { line: 1, character: 2 }, end: { line: 1, character: 16 } });
  assert.deepEqual(openMapCompletions(mockMap, '  $.mock[0].size: ').map((item) => item.label), ['low', 'high']);
  assert.deepEqual(hintAfter(mockMap, '  $.mock[*].size').rows, ['<key>: low | high']);
  assert.deepEqual(hintAfter(mockMap, '  $.mock[*].size: ').rows, ['$.mock[*].size: low | high']);
});

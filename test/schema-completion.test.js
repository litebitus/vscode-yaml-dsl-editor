const test = require('node:test');
const assert = require('node:assert/strict');
const { schemaCompletionsAt } = require('../lib/schema-completion');

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

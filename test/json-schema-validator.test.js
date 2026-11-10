const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { schemaValidatorFor } = require('../lib/json-schema');
const { createValidationHost } = require('../lib/validation-host');
const { resolvedDocumentOf } = require('../lib/resolved-document');
const { validationProblemsOf, quotedValuesValidator, problemTextsOf } = require('./validation-builders');

const DRAFT_URIS = [
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
];

function mockSchema(draftUri) {
  return {
    $schema: draftUri,
    type: 'object',
    additionalProperties: false,
    properties: {
      mocktype: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['label'],
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            size: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^ref ' }] },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

function problemsOf(schema, value, options = {}) {
  return problemTextsOf(validationProblemsOf(schema, value, options));
}

test('each draft validates with its own validator, a failure carrying its path, keyword and message', () => {
  for (const draftUri of DRAFT_URIS) {
    const schema = mockSchema(draftUri);
    assert.deepEqual(problemsOf(schema, { mocktype: { primary: { label: 'mock' } } }), [], draftUri);
    assert.deepEqual(problemsOf(schema, { mocktype: { primary: { label: 1, tags: ['mock-tag', 2] } } }), [
      [['mocktype', 'primary', 'label'], '`label` must be `string`'],
      [['mocktype', 'primary', 'tags', 1], '`tags[1]` must be `string`'],
    ], draftUri);
  }
});

test('a quoted value of an allowed type is validated as the value it spells, its constraints still checked', () => {
  const schema = {
    $schema: DRAFT_URIS[2],
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      count: { type: 'integer', maximum: 900 },
      ratio: { type: 'number' },
      label: { type: 'string' },
      sizes: { type: 'array', items: { type: 'integer' } },
    },
  };
  const validator = quotedValuesValidator(['boolean', 'integer', 'number']);
  const quoted = { enabled: 'true', count: '12', ratio: '-1.5e3', label: '12', sizes: ['1', '2'] };
  assert.deepEqual(problemsOf(schema, quoted, { validator }), []);
  assert.deepEqual(problemsOf(schema, { enabled: 'yes', count: '901', ratio: '1.', sizes: ['01', '2.5'] }, { validator }), [
    [['enabled'], '`enabled` must be `boolean`'],
    [['count'], '`count` must be <= `900`'],
    [['ratio'], '`ratio` must be `number`'],
    [['sizes', 0], '`sizes[0]` must be `integer`'],
    [['sizes', 1], '`sizes[1]` must be `integer`'],
  ]);
});

test('a quoted value is read only as a type the config lists, and only where the schema expects that type', () => {
  const schema = {
    $schema: DRAFT_URIS[2],
    type: 'object',
    properties: { enabled: { type: 'boolean' }, count: { type: 'integer' }, ratio: { type: 'number' } },
  };
  const quoted = { enabled: 'true', count: '12', ratio: '12' };
  assert.deepEqual(problemsOf(schema, quoted), [
    [['enabled'], '`enabled` must be `boolean`'],
    [['count'], '`count` must be `integer`'],
    [['ratio'], '`ratio` must be `number`'],
  ]);
  assert.deepEqual(problemsOf(schema, quoted, { validator: quotedValuesValidator(['boolean']) }), [
    [['count'], '`count` must be `integer`'],
    [['ratio'], '`ratio` must be `number`'],
  ]);
  assert.deepEqual(problemsOf(schema, quoted, { validator: quotedValuesValidator(['number']) }), [
    [['enabled'], '`enabled` must be `boolean`'],
    [['count'], '`count` must be `integer`'],
  ]);
  assert.deepEqual(problemsOf(schema, { count: '1.5' }, { validator: quotedValuesValidator(['integer', 'number']) }), [
    [['count'], '`count` must be `integer`'],
  ]);
});

test('an alternative none of whose branches holds is one failure, without the branches\' own', () => {
  assert.deepEqual(problemsOf(mockSchema(DRAFT_URIS[2]), { mocktype: { primary: { label: 'mock', size: 'mock-size' } } }), [
    [['mocktype', 'primary', 'size'], '`size` matches none of its allowed forms'],
  ]);
});

test('an alternative failure carries each set of missing fields whose presence would make it hold, nested ones '
  + 'combined, and none for a branch failing otherwise', () => {
  for (const draftUri of DRAFT_URIS) {
    const schema = {
      $schema: draftUri,
      properties: {
        mocktype: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              required: ['label'],
              properties: {
                label: { type: 'string' },
                mode: { anyOf: [{ type: 'object', required: ['kind'] }, { type: 'object', required: ['ref'] }] },
              },
            },
          ],
        },
      },
    };
    const noFormHolds = [[['mocktype'], '`mocktype` matches none of its allowed forms']];
    assert.deepEqual(problemsOf(schema, { mocktype: { mode: {} } }), noFormHolds, draftUri);
    assert.deepEqual(problemsOf(schema, { mocktype: { label: 1 } }), noFormHolds, draftUri);
  }
});

test('a key its map\'s key schema rejects is one failure naming the key, without the key schema\'s own', () => {
  const schema = {
    $schema: DRAFT_URIS[0],
    definitions: { mock_key: { type: 'string', pattern: '^[a-z_]+$' } },
    properties: { mocktype: { type: 'object', propertyNames: { $ref: '#/definitions/mock_key' } } },
  };
  assert.deepEqual(problemsOf(schema, { mocktype: { mock_good: {}, 'mock-bad': {} } }), [
    [['mocktype', 'mock-bad'], '`mock-bad` is not a valid key of `mocktype`'],
  ]);
});

test('a missing required field and an unknown field are failures of their map', () => {
  assert.deepEqual(problemsOf(mockSchema(DRAFT_URIS[0]), { mocktype: { primary: { mock_field: 1 } } }), [
    [['mocktype', 'primary'], '`label` is required'],
    [['mocktype', 'primary', 'mock_field'], '`mock_field` is not defined in the schema'],
  ]);
});

test('a dependency its key does not meet is one failure naming the key, in each draft\'s keywords', () => {
  const holderOf = (draftUri, dependencyKeywords) => ({
    $schema: draftUri,
    properties: { mocktype: { type: 'object', ...dependencyKeywords } },
  });
  const anyOfNeeds = { anyOf: [{ required: ['size'] }, { required: ['kind'] }] };
  const holders = [
    holderOf(DRAFT_URIS[0], { dependencies: { label: ['size'], mode: anyOfNeeds } }),
    holderOf(DRAFT_URIS[1], { dependentRequired: { label: ['size'] }, dependentSchemas: { mode: anyOfNeeds } }),
    holderOf(DRAFT_URIS[2], { dependentRequired: { label: ['size'] }, dependentSchemas: { mode: anyOfNeeds } }),
  ];
  for (const holder of holders) {
    assert.deepEqual(problemsOf(holder, { mocktype: { label: 'mock', mode: 'mock' } }), [
      [['mocktype', 'label'], '`label` needs `size`'],
      [['mocktype', 'mode'], '`mode` needs `size`, or `kind`'],
    ], holder.$schema);
  }
});

test('a dependent schema\'s failure inside a field of its holder stays that field\'s own', () => {
  const schema = {
    $schema: DRAFT_URIS[2],
    properties: {
      mocktype: { type: 'object', dependentSchemas: { label: { properties: { size: { type: 'integer' } } } } },
    },
  };
  assert.deepEqual(problemsOf(schema, { mocktype: { label: 'mock', size: 'mock-size' } }), [
    [['mocktype', 'size'], '`size` must be `integer`'],
  ]);
});

test('a schema that cannot be compiled is one failure at the document, and an unread draft has no validator', () => {
  const broken = { $schema: DRAFT_URIS[2], properties: { label: { $ref: '#/$defs/missing' } } };
  assert.deepEqual(problemsOf(broken, { label: 'mock' }), [
    [[], 'the schema cannot be compiled: `#/$defs/missing` names no node of the schema'],
  ]);
  assert.equal(schemaValidatorFor({ $schema: 'https://example.com/mock-draft' }), null);
  assert.equal(schemaValidatorFor(null), null);
});

test('a fragment is validated against the node its pointer names, with no key required at any depth', () => {
  for (const draftUri of DRAFT_URIS) {
    const schema = {
      ...mockSchema(draftUri),
      required: ['mocktype'],
      definitions: {
        mock_entry: {
          type: 'object',
          required: ['label'],
          properties: {
            label: { type: 'string' },
            mode: { anyOf: [{ type: 'object', required: ['kind'] }, { type: 'string' }] },
          },
        },
      },
    };
    assert.deepEqual(problemsOf(schema, {}, { fragmentPointer: '' }), [], draftUri);
    assert.deepEqual(problemsOf(schema, {}), [[[], '`mocktype` is required']], draftUri);
    const atMocktype = { fragmentPointer: '/properties/mocktype' };
    assert.deepEqual(problemsOf(schema, { primary: {} }, atMocktype), [], draftUri);
    assert.deepEqual(problemsOf(schema, { primary: { label: 1 } }, atMocktype), [
      [['primary', 'label'], '`label` must be `string`'],
    ], draftUri);
    const atEntry = { fragmentPointer: '/definitions/mock_entry' };
    assert.deepEqual(problemsOf(schema, { mode: {} }, atEntry), [], draftUri);
    assert.deepEqual(problemsOf(schema, { mode: 1 }, atEntry), [
      [['mode'], '`mode` matches none of its allowed forms'],
    ], draftUri);
    assert.deepEqual(problemsOf(schema, {}, { fragmentPointer: '/properties/nothing' }), [
      [[], 'the schema has no node at `#/properties/nothing`'],
    ], draftUri);
  }
});

test('a pattern is built with the u flag, so a Unicode property escape and a code point escape are read', () => {
  for (const draftUri of DRAFT_URIS) {
    const schema = {
      $schema: draftUri,
      type: 'object',
      properties: {
        letters: { type: 'string', pattern: '^\\p{L}+$' },
        astral: { type: 'string', pattern: '^[\\u{1F600}-\\u{1F64F}]$' },
      },
      patternProperties: { '^\\p{Lu}': { type: 'integer' } },
    };
    assert.deepEqual(problemsOf(schema, { letters: 'éß', astral: '😀', Mock: 1 }), [], draftUri);
    assert.deepEqual(problemsOf(schema, { letters: 'mock-1', astral: 'x', Mock: 'x' }), [
      [['letters'], '`letters` must match pattern `^\\p{L}+$`'],
      [['astral'], '`astral` must match pattern `^[\\u{1F600}-\\u{1F64F}]$`'],
      [['Mock'], '`Mock` must be `integer`'],
    ], draftUri);
  }
});

test('a branch condition is compiled alone, so a part of the schema that cannot compile leaves it read', () => {
  const condition = { properties: { kind: { const: 'mock-bucket' } }, required: ['kind'] };
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { broken: { type: 'string', pattern: '(' } },
    allOf: [{ if: condition, then: { required: ['bucket'] } }],
  };
  const validator = schemaValidatorFor(schema);
  assert.equal(validator.conditionHolds(condition, { kind: 'mock-bucket' }), true);
  assert.equal(validator.conditionHolds(condition, { kind: 'mock-queue' }), false);
  assert.deepEqual(problemsOf(schema, {}), [
    [[], 'the schema cannot be compiled: `(` is not a pattern'],
  ]);
  const unreadable = { properties: { kind: { pattern: '(' } } };
  assert.equal(validator.conditionHolds(unreadable, { kind: 'mock-bucket' }), null);
  assert.equal(validator.conditionHolds(true, {}), true);
});

test('a schema with a reference naming no node does not load, whatever part a fragment names', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { entry: { properties: { gone: { $ref: '#/$defs/mock_missing' } } } },
  };
  assert.deepEqual(problemsOf(schema, {}, { fragmentPointer: '/properties/entry' }), [
    [[], 'the schema cannot be compiled: `#/$defs/mock_missing` names no node of the schema'],
  ]);
  const unreferencedDefinition = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { mock_entry: { properties: { gone: { $ref: '#/$defs/mock_missing' } } } },
    properties: { name: { type: 'string' } },
  };
  assert.deepEqual(problemsOf(unreferencedDefinition, {}, { fragmentPointer: '/$defs/mock_entry' }), [
    [[], 'the schema cannot be compiled: `#/$defs/mock_missing` names no node of the schema'],
  ]);
});

test('a part of the schema compiled alone resolves its references in the schema, and data keeps its $ref keys', () => {
  for (const draftUri of DRAFT_URIS) {
    const definitionsKeyword = draftUri.includes('draft-07') ? 'definitions' : '$defs';
    const condition = { $ref: `#/${definitionsKeyword}/mock_kind` };
    const schema = {
      $schema: draftUri,
      [definitionsKeyword]: { mock_kind: { properties: { kind: { const: 'mock-bucket' } }, required: ['kind'] } },
      properties: { size: { type: 'integer', minimum: 1 } },
      allOf: [{ if: condition, then: { required: ['bucket'] } }],
    };
    const validator = schemaValidatorFor(schema);
    assert.equal(validator.conditionHolds(condition, { kind: 'mock-bucket' }), true, draftUri);
    assert.equal(validator.conditionHolds(condition, { kind: 'mock-queue' }), false, draftUri);
    const part = validator.compileRootPart({
      properties: { size: { $ref: '#/properties/size' }, marker: { const: { $ref: '#/mock' } } },
    });
    assert.equal(part({ size: 2, marker: { $ref: '#/mock' } }), true, draftUri);
    assert.equal(part({ size: 0 }), false, draftUri);
    assert.equal(part({ marker: { $ref: 'yaml-dsl-editor-root#/mock' } }), false, draftUri);
  }
});

test('a part compiled alone carries only the nodes its references reach, through lists, anchors and the root', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      mock_name: { type: 'string', minLength: 2 },
      mock_tagged: { $anchor: 'mock-tag', type: 'string', pattern: '^tag-' },
      mock_broken: { type: 'string', pattern: '(' },
      mock_chain: { $ref: '#/$defs/mock_name' },
    },
    allOf: [{ required: ['name'] }, { properties: { size: { type: 'integer' } } }],
    properties: { name: { $ref: '#/$defs/mock_chain' } },
  };
  const validator = schemaValidatorFor(schema);
  const chained = validator.compileRootPart({ properties: { name: { $ref: '#/$defs/mock_chain' } } });
  assert.equal(chained({ name: 'mock-name' }), true);
  assert.equal(chained({ name: 'm' }), false);
  const listed = validator.compileRootPart({ properties: { size: { $ref: '#/allOf/1/properties/size' } } });
  assert.equal(listed({ size: 1 }), true);
  assert.equal(listed({ size: 'mock' }), false);
  const anchored = validator.compileRootPart({ properties: { tag: { $ref: '#mock-tag' } } });
  assert.equal(anchored({ tag: 'tag-mock' }), true);
  assert.equal(anchored({ tag: 'mock' }), false);
  const plain = validator.compileRootPart({ required: ['name'] });
  assert.equal(plain({}), false);
  assert.throws(() => validator.compileRootPart({ properties: { broken: { $ref: '#/$defs/mock_broken' } } }));
  const whole = validator.compileRootPart({ properties: { nested: { $ref: '#' } } });
  assert.equal(whole({ nested: { name: 'mock-name' } }), true);
  assert.equal(whole({ nested: {} }), false);
  assert.throws(() => validator.compileRootPart({ properties: { gone: { $ref: '#/$defs/mock_missing' } } }));
});

const schemaStore = { folder: null };

function storedProblemsOf(schemaText, value) {
  const host = createValidationHost({ reportProblem: (message) => assert.fail(message) });
  host.addSchema('mock-schema-hash', schemaText, schemaStore.folder);
  return problemTextsOf(host.problemsOf('mock-schema-hash', resolvedDocumentOf(value)));
}

function storedEntries() {
  return fs.readdirSync(schemaStore.folder).map((name) => {
    const file = path.join(schemaStore.folder, name);
    return { name, text: fs.readFileSync(file, 'utf8'), inode: fs.statSync(file).ino };
  });
}

const savedSchemaText = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  $defs: { mock_size: { description: 'mock-unique-size-description', type: 'integer', minimum: 1 } },
  properties: {
    size: { $ref: '#/$defs/mock_size' },
    mode: { anyOf: [{ type: 'string', pattern: '^mock-' }, { type: 'object', required: ['kind'] }] },
  },
});

test.describe('the schema store', () => {
  test.beforeEach(() => {
    schemaStore.folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-schema-store-'));
  });

  test.afterEach(() => {
    schemaStore.folder = null;
  });

  test('a prepared schema is kept in the schema store, and a later cache reads it instead of preparing it, '
    + 'failing the same way', () => {
    const document = { size: 0, mode: 3, extra: true };
    const prepared = storedProblemsOf(savedSchemaText, document);
    const [entry] = storedEntries();
    assert.match(entry.name, /^[0-9a-f]{64}\.json$/);
    assert.deepEqual(Object.keys(JSON.parse(entry.text)).sort(), ['draft', 'marked', 'schema']);
    const read = storedProblemsOf(savedSchemaText, document);
    assert.deepEqual(storedEntries(), [entry]);
    assert.deepEqual(read, prepared);
    assert.deepEqual(prepared, [
      [['size'], '`size` must be >= `1`'],
      [['mode'], '`mode` matches none of its allowed forms'],
      [['extra'], '`extra` is not defined in the schema'],
    ]);
  });

  test('a failed not carries the description of the schema it rules out, '
    + 'from a prepared schema and a stored one', () => {
    const schemaText = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { mapping: { not: { description: 'Mock: no `color` here.', required: ['color'] } } },
    });
    const document = { mapping: { color: 'red' } };
    const prepared = storedProblemsOf(schemaText, document);
    const stored = storedProblemsOf(schemaText, document);
    assert.equal(storedEntries().length, 1);
    for (const problems of [prepared, stored]) {
      assert.deepEqual(problems, [
        [['mapping'], '`mapping` matches a form that is not allowed', 'Mock: no `color` here.'],
      ]);
    }
  });

  test('a failed uniqueItems names its later and earlier duplicate, '
    + 'and a failed contains stands for its items\' failures', () => {
    const schemaText = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { unique: { uniqueItems: true }, containing: { contains: { const: 1 } } },
    });
    const document = { unique: [2, 1, 1, 2], containing: [2, 3] };
    for (const problems of [storedProblemsOf(schemaText, document), storedProblemsOf(schemaText, document)]) {
      assert.deepEqual(problems, [
        [['unique'], '`unique` must NOT have duplicate items (items ## 2 and 1 are identical)'],
        [['containing'], '`containing` must contain at least `1` valid item(s)'],
      ]);
    }
  });

  test('a stored schema that cannot be read is prepared again and stored over', () => {
    storedProblemsOf(savedSchemaText, { size: 0 });
    const [entry] = storedEntries();
    for (const unreadable of ['this is not json (', '{"draft":"mock-draft"}']) {
      fs.writeFileSync(path.join(schemaStore.folder, entry.name), unreadable);
      assert.deepEqual(storedProblemsOf(savedSchemaText, { size: 0 }), [[['size'], '`size` must be >= `1`']]);
      assert.deepEqual(storedEntries().map(({ name, text }) => [name, text]), [[entry.name, entry.text]]);
    }
  });
});

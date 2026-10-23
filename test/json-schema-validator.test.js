const test = require('node:test');
const assert = require('node:assert/strict');
const { schemaValidatorFor } = require('../lib/json-schema');
const { SCHEMA_COMPILE_KEYWORD, DEPENDENCY_KEYWORD } = require('../lib/json-schema/validator');

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

test('each draft validates with its own validator, a failure carrying its path, keyword and message', () => {
  for (const draftUri of DRAFT_URIS) {
    const validator = schemaValidatorFor(mockSchema(draftUri));
    assert.deepEqual(validator.documentFailures({ mocktype: { primary: { label: 'mock' } } }), [], draftUri);
    const failures = validator.documentFailures({ mocktype: { primary: { label: 1, tags: ['mock-tag', 2] } } });
    assert.deepEqual(failures.map(({ path, keyword }) => [path, keyword]), [
      [['mocktype', 'primary', 'label'], 'type'],
      [['mocktype', 'primary', 'tags', 1], 'type'],
    ], draftUri);
    assert.equal(failures[0].message, 'must be string');
  }
});

test('a quoted value of an allowed type is validated as the value it spells, its constraints still checked', () => {
  const validator = schemaValidatorFor({
    $schema: DRAFT_URIS[2],
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      count: { type: 'integer', maximum: 900 },
      ratio: { type: 'number' },
      label: { type: 'string' },
      sizes: { type: 'array', items: { type: 'integer' } },
    },
  });
  const allowQuotedValues = ['boolean', 'integer', 'number'];
  const quoted = { enabled: 'true', count: '12', ratio: '-1.5e3', label: '12', sizes: ['1', '2'] };
  assert.deepEqual(validator.documentFailures(quoted, { allowQuotedValues }), []);
  const failures = validator.documentFailures(
    { enabled: 'yes', count: '901', ratio: '1.', sizes: ['01', '2.5'] },
    { allowQuotedValues },
  );
  assert.deepEqual(failures.map(({ path, keyword }) => [path, keyword]), [
    [['enabled'], 'type'],
    [['count'], 'maximum'],
    [['ratio'], 'type'],
    [['sizes', 0], 'type'],
    [['sizes', 1], 'type'],
  ]);
});

test('a quoted value is read only as a type the config lists, and only where the schema expects that type', () => {
  const validator = schemaValidatorFor({
    $schema: DRAFT_URIS[2],
    type: 'object',
    properties: { enabled: { type: 'boolean' }, count: { type: 'integer' }, ratio: { type: 'number' } },
  });
  const quoted = { enabled: 'true', count: '12', ratio: '12' };
  assert.deepEqual(validator.documentFailures(quoted).map(({ path }) => path), [['enabled'], ['count'], ['ratio']]);
  assert.deepEqual(
    validator.documentFailures(quoted, { allowQuotedValues: ['boolean'] }).map(({ path }) => path),
    [['count'], ['ratio']],
  );
  assert.deepEqual(
    validator.documentFailures(quoted, { allowQuotedValues: ['number'] }).map(({ path }) => path),
    [['enabled'], ['count']],
  );
  assert.deepEqual(
    validator.documentFailures({ count: '1.5' }, { allowQuotedValues: ['integer', 'number'] }).map(({ keyword }) => keyword),
    ['type'],
  );
});

test('an alternative none of whose branches holds is one failure, without the branches\' own', () => {
  const validator = schemaValidatorFor(mockSchema(DRAFT_URIS[2]));
  const failures = validator.documentFailures({ mocktype: { primary: { label: 'mock', size: 'mock-size' } } });
  assert.deepEqual(failures.map(({ path, keyword }) => [path, keyword]), [[['mocktype', 'primary', 'size'], 'anyOf']]);
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
    const validator = schemaValidatorFor(schema);
    const requirementSetsOf = (value) => validator.documentFailures(value)
      .map(({ path, keyword, requirementSetsToPass }) => [path, keyword, requirementSetsToPass]);
    const missing = (path, requiredField) => ({ path, keyword: 'required', requiredField });
    assert.deepEqual(requirementSetsOf({ mocktype: { mode: {} } }), [
      [['mocktype'], 'oneOf', [
        [missing(['mocktype'], 'label'), missing(['mocktype', 'mode'], 'kind')],
        [missing(['mocktype'], 'label'), missing(['mocktype', 'mode'], 'ref')],
      ]],
    ], draftUri);
    assert.deepEqual(requirementSetsOf({ mocktype: { label: 1 } }), [
      [['mocktype'], 'oneOf', undefined],
    ], draftUri);
  }
});

test('a key its map\'s key schema rejects is one failure naming the key, without the key schema\'s own', () => {
  const validator = schemaValidatorFor({
    $schema: DRAFT_URIS[0],
    definitions: { mock_key: { type: 'string', pattern: '^[a-z_]+$' } },
    properties: { mocktype: { type: 'object', propertyNames: { $ref: '#/definitions/mock_key' } } },
  });
  const failures = validator.documentFailures({ mocktype: { mock_good: {}, 'mock-bad': {} } });
  assert.deepEqual(failures.map(({ path, keyword, params }) => [path, keyword, params]), [
    [['mocktype'], 'propertyNames', { propertyName: 'mock-bad' }],
  ]);
});

test('a missing required field and an unknown field are failures of their map', () => {
  const validator = schemaValidatorFor(mockSchema(DRAFT_URIS[0]));
  const failures = validator.documentFailures({ mocktype: { primary: { mock_field: 1 } } });
  assert.deepEqual(failures.map(({ path, keyword, params }) => [path, keyword, params]), [
    [['mocktype', 'primary'], 'required', { missingProperty: 'label' }],
    [['mocktype', 'primary'], 'additionalProperties', { additionalProperty: 'mock_field' }],
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
    const failures = schemaValidatorFor(holder).documentFailures({ mocktype: { label: 'mock', mode: 'mock' } });
    assert.deepEqual(failures.map(({ path, keyword, params }) => [path, keyword, params]), [
      [['mocktype'], DEPENDENCY_KEYWORD, { property: 'label' }],
      [['mocktype'], DEPENDENCY_KEYWORD, { property: 'mode' }],
    ], holder.$schema);
  }
});

test('a dependent schema\'s failure inside a field of its holder stays that field\'s own', () => {
  const validator = schemaValidatorFor({
    $schema: DRAFT_URIS[2],
    properties: {
      mocktype: { type: 'object', dependentSchemas: { label: { properties: { size: { type: 'integer' } } } } },
    },
  });
  const failures = validator.documentFailures({ mocktype: { label: 'mock', size: 'mock-size' } });
  assert.deepEqual(failures.map(({ path, keyword }) => [path, keyword]), [[['mocktype', 'size'], 'type']]);
});

test('a schema that cannot be compiled is one failure at the document, and an unread draft has no validator', () => {
  const broken = { $schema: DRAFT_URIS[2], properties: { label: { $ref: '#/$defs/missing' } } };
  const [failure] = schemaValidatorFor(broken).documentFailures({ label: 'mock' });
  assert.deepEqual([failure.path, failure.keyword], [[], SCHEMA_COMPILE_KEYWORD]);
  assert.match(failure.message, /^the schema cannot be compiled: /);
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
    const validator = schemaValidatorFor(schema);
    const keywordsOf = (failures) => failures.map(({ path, keyword }) => [path, keyword]);
    assert.deepEqual(validator.documentFailures({}, { fragmentPointer: '' }), [], draftUri);
    assert.deepEqual(keywordsOf(validator.documentFailures({}).filter((failure) => failure.keyword === 'required')), [
      [[], 'required'],
    ], draftUri);
    const atMocktype = { fragmentPointer: '/properties/mocktype' };
    assert.deepEqual(validator.documentFailures({ primary: {} }, atMocktype), [], draftUri);
    assert.deepEqual(keywordsOf(validator.documentFailures({ primary: { label: 1 } }, atMocktype)), [
      [['primary', 'label'], 'type'],
    ], draftUri);
    const atEntry = { fragmentPointer: '/definitions/mock_entry' };
    assert.deepEqual(validator.documentFailures({ mode: {} }, atEntry), [], draftUri);
    assert.deepEqual(keywordsOf(validator.documentFailures({ mode: 1 }, atEntry)), [[['mode'], 'anyOf']], draftUri);
    const unread = validator.documentFailures({}, { fragmentPointer: '/properties/nothing' });
    assert.deepEqual(unread.map((failure) => failure.message), ['the schema has no node at `#/properties/nothing`']);
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
    const validator = schemaValidatorFor(schema);
    const keywordsOf = (value) => validator.documentFailures(value).map(({ path, keyword }) => [path, keyword]);
    assert.deepEqual(keywordsOf({ letters: 'éß', astral: '😀', Mock: 1 }), [], draftUri);
    assert.deepEqual(keywordsOf({ letters: 'mock-1', astral: 'x', Mock: 'x' }), [
      [['letters'], 'pattern'],
      [['astral'], 'pattern'],
      [['Mock'], 'type'],
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
  assert.deepEqual(validator.documentFailures({}).map((failure) => failure.keyword), [SCHEMA_COMPILE_KEYWORD]);
  const unreadable = { properties: { kind: { pattern: '(' } } };
  assert.equal(validator.conditionHolds(unreadable, { kind: 'mock-bucket' }), null);
  assert.equal(validator.conditionHolds(true, {}), true);
});

test('a fragment whose node cannot be compiled reads as a node the schema does not have', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { entry: { properties: { gone: { $ref: '#/$defs/mock_missing' } } } },
  };
  const failures = schemaValidatorFor(schema).documentFailures({}, { fragmentPointer: '/properties/entry' });
  assert.deepEqual(failures.map((failure) => failure.message), [
    'the schema cannot be compiled: can\'t resolve reference #/$defs/mock_missing from id #',
  ]);
  const compilable = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { mock_entry: { properties: { gone: { $ref: '#/$defs/mock_missing' } } } },
    properties: { name: { type: 'string' } },
  };
  const fragment = schemaValidatorFor(compilable).documentFailures({}, { fragmentPointer: '/$defs/mock_entry' });
  assert.deepEqual(fragment.map((failure) => failure.message), ['the schema has no node at `#/$defs/mock_entry`']);
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

function memoryCompiledRootStore(savedSource = null) {
  const store = {
    filename: '/mock/compiled-schema.js',
    saved: [],
    load: () => savedSource,
    save: (source) => store.saved.push(source),
  };
  return store;
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

test('a compiled root is saved with references to the schema\'s own nodes, and a saved one is loaded instead '
  + 'of compiled, failing the same way', () => {
  const document = { size: 0, mode: 3, extra: true };
  const compiling = memoryCompiledRootStore();
  const compiled = schemaValidatorFor(JSON.parse(savedSchemaText), compiling).documentFailures(document);
  assert.equal(compiling.saved.length, 1);
  const [source] = compiling.saved;
  assert.match(source, /schemaNode\("\/\$defs\/mock_size"\)/);
  assert.doesNotMatch(source, /mock-unique-size-description/);
  const loading = memoryCompiledRootStore(source);
  const loaded = schemaValidatorFor(JSON.parse(savedSchemaText), loading).documentFailures(document);
  assert.deepEqual(loaded, compiled);
  assert.deepEqual(compiled.map(({ path, keyword }) => [path, keyword]), [
    [[], 'additionalProperties'],
    [['size'], 'minimum'],
    [['mode'], 'anyOf'],
  ]);
  assert.equal(loading.saved.length, 0);
});

test('a saved compiled root that cannot be loaded is compiled again and saved over', () => {
  for (const unreadable of ['this is not javascript (', '"use strict";module.exports = 1;']) {
    const store = memoryCompiledRootStore(unreadable);
    const failures = schemaValidatorFor(JSON.parse(savedSchemaText), store).documentFailures({ size: 0 });
    assert.deepEqual(failures.map(({ path, keyword }) => [path, keyword]), [[['size'], 'minimum']]);
    assert.equal(store.saved.length, 1);
  }
});

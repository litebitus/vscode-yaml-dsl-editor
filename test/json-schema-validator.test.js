const test = require('node:test');
const assert = require('node:assert/strict');
const { schemaValidatorFor } = require('../lib/json-schema');
const { SCHEMA_COMPILE_KEYWORD } = require('../lib/json-schema/validator');

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

test('an alternative none of whose branches holds is one failure, without the branches\' own', () => {
  const validator = schemaValidatorFor(mockSchema(DRAFT_URIS[2]));
  const failures = validator.documentFailures({ mocktype: { primary: { label: 'mock', size: 'mock-size' } } });
  assert.deepEqual(failures.map(({ path, keyword }) => [path, keyword]), [[['mocktype', 'primary', 'size'], 'anyOf']]);
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

test('a schema that cannot be compiled is one failure at the document, and an unread draft has no validator', () => {
  const broken = { $schema: DRAFT_URIS[2], properties: { label: { $ref: '#/$defs/missing' } } };
  const [failure] = schemaValidatorFor(broken).documentFailures({ label: 'mock' });
  assert.deepEqual([failure.path, failure.keyword], [[], SCHEMA_COMPILE_KEYWORD]);
  assert.match(failure.message, /^the schema cannot be compiled: /);
  assert.equal(schemaValidatorFor({ $schema: 'https://example.com/mock-draft' }), null);
  assert.equal(schemaValidatorFor(null), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  JSON_SCHEMA_DRAFTS,
  draftOfSchema,
  unreadDraftProblem,
  schemaParserFor,
  schemaParserForDocument,
} = require('../lib/json-schema');
const { createSchemaChecks } = require('../lib/schema-checks');

const DRAFT_07_URI = 'http://json-schema.org/draft-07/schema#';
const DRAFT_2019_09_URI = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';

function descriptionOf(root, path) {
  const parser = schemaParserFor(root);
  return parser ? parser.fieldDescription(path) : null;
}

const mockSchema = {
  description: 'root',
  properties: {
    mocktype: { $ref: '#/definitions/mocktype_map', description: '[optional] Mock things.' },
    tags: { additionalProperties: { description: 'tag value' } },
    open: { additionalProperties: true },
    bad: { patternProperties: { '(': { description: 'nope' } }, additionalProperties: false },
    extra: {
      patternProperties: { '(': { description: 'nope' }, '^x': { description: 'first' } },
      additionalProperties: { description: 'fallback field' },
    },
    list: { items: { description: 'item' } },
    tuple: { items: [{ description: 'first item' }], additionalItems: false },
  },
  definitions: {
    string_or_ref: { description: 'a literal string, a ref, or a bare local' },
    mocktype_map: { patternProperties: { '^(?!defaults$).+$': { $ref: '#/definitions/mocktype' } } },
    mocktype: { allOf: [{ $ref: '#/definitions/mocktype_body' }] },
    mocktype_body: {
      properties: {
        label: { $ref: '#/definitions/string_or_ref', description: '[optional] Mock label.' },
      },
    },
    loop: { $ref: '#/definitions/loop' },
  },
};

test('hover keeps the description beside $ref', () => {
  assert.equal(descriptionOf(mockSchema, ['mocktype', 'primary', 'label']), '[optional] Mock label.');
  assert.equal(descriptionOf(mockSchema, ['mocktype']), '[optional] Mock things.');
  assert.equal(descriptionOf(mockSchema, ['mocktype', 'primary']), null);
  assert.equal(descriptionOf(mockSchema, []), 'root');
  assert.equal(descriptionOf(mockSchema, ['tags', 'Name']), 'tag value');
  assert.equal(descriptionOf(mockSchema, ['extra', 'x']), 'first');
  assert.equal(descriptionOf(mockSchema, ['extra', 'y']), 'fallback field');
  assert.equal(descriptionOf(mockSchema, ['list', 0]), 'item');
  assert.equal(descriptionOf(mockSchema, ['tuple', 0]), 'first item');
});

test('a missing or unusable schema node has no description', () => {
  assert.equal(descriptionOf(null, []), null);
  assert.equal(descriptionOf([], []), null);
  assert.equal(descriptionOf(mockSchema, ['missing']), null);
  assert.equal(descriptionOf(mockSchema, ['open', 'x']), null);
  assert.equal(descriptionOf(mockSchema, ['bad', 'x']), null);
  assert.equal(descriptionOf(mockSchema, ['tuple', 1]), null);
  assert.equal(descriptionOf(mockSchema, ['list', 'nope']), null);
  assert.equal(descriptionOf({ properties: { a: { $ref: '#/nope', description: 'kept' } } }, ['a', 'b']), null);
  const remote = { properties: { a: { $ref: 'http://example.test/schema', description: 'kept' } } };
  assert.equal(descriptionOf(remote, ['a']), 'kept');
  const cyclic = {
    properties: { a: { $ref: '#/definitions/loop', description: 'cycle' } },
    definitions: { loop: { $ref: '#/definitions/loop' } },
  };
  assert.equal(descriptionOf(cyclic, ['a']), 'cycle');
});

test('a schema is read by the draft its $schema declares, draft-07 when it declares none or an older one', () => {
  assert.deepEqual(JSON_SCHEMA_DRAFTS.map((draft) => draft.name), ['draft-07', 'draft 2019-09', 'draft 2020-12']);
  assert.equal(draftOfSchema({}).name, 'draft-07');
  assert.equal(draftOfSchema({ $schema: DRAFT_07_URI }).name, 'draft-07');
  assert.equal(draftOfSchema({ $schema: DRAFT_2019_09_URI }).name, 'draft 2019-09');
  assert.equal(draftOfSchema({ $schema: DRAFT_2020_12_URI }).name, 'draft 2020-12');
  for (const olderUri of [
    'http://json-schema.org/draft-03/schema#',
    'http://json-schema.org/draft-04/schema#',
    'http://json-schema.org/draft-06/schema',
  ]) {
    assert.equal(draftOfSchema({ $schema: olderUri }).name, 'draft-07');
    assert.equal(unreadDraftProblem({ $schema: olderUri }), null);
  }
  const unknownDraft = { $schema: 'https://json-schema.org/draft/mock-future/schema' };
  assert.equal(draftOfSchema(unknownDraft), null);
  assert.equal(schemaParserFor(unknownDraft), null);
  assert.equal(
    unreadDraftProblem(unknownDraft),
    'schema declares "https://json-schema.org/draft/mock-future/schema", a draft the editor does not read; '
      + 'it reads draft-07, draft 2019-09, draft 2020-12',
  );
  assert.equal(unreadDraftProblem({ $schema: DRAFT_2020_12_URI }), null);
});

test('draft-07 reads tuples with additionalItems, plain-name $id anchors, and no deprecated keyword', () => {
  const draft07 = schemaParserFor({
    $schema: DRAFT_07_URI,
    properties: {
      pair: { items: [{ type: 'string' }, { type: 'number' }], additionalItems: false },
      named: { $ref: '#mock-anchor' },
      old: { type: 'string', deprecated: true },
    },
    definitions: { anchored: { $id: '#mock-anchor', properties: { size: { type: 'integer' } } } },
  });
  assert.equal(draft07.nodeAt(['pair', 1]).type, 'number');
  assert.equal(draft07.nodeAt(['pair', 2]), null);
  assert.equal(draft07.nodeAt(['named', 'size']).type, 'integer');
  assert.equal(draft07.fieldDeprecated(['old']), false);
});

test('draft 2019-09 reads $anchor, $recursiveRef, dependentSchemas, unevaluatedProperties and deprecated', () => {
  const draft2019 = schemaParserFor({
    $schema: DRAFT_2019_09_URI,
    $recursiveAnchor: true,
    properties: {
      named: { $ref: '#mock-anchor' },
      nested: { $recursiveRef: '#' },
      gated: {
        dependentSchemas: { mode: { properties: { extra: { type: 'boolean' } } } },
        unevaluatedProperties: false,
      },
      old: { $ref: '#/$defs/legacy', deprecated: true },
      inherited: { $ref: '#/$defs/legacy' },
    },
    $defs: {
      anchored: { $anchor: 'mock-anchor', properties: { size: { type: 'integer' } } },
      legacy: { type: 'string' },
    },
  });
  assert.equal(draft2019.nodeAt(['named', 'size']).type, 'integer');
  assert.equal(draft2019.nodeAt(['nested', 'named', 'size']).type, 'integer');
  assert.equal(draft2019.nodeAt(['gated', 'extra']).type, 'boolean');
  assert.equal(draft2019.nodeAt(['gated', 'other']), null);
  assert.equal(draft2019.fieldDeprecated(['old']), true);
  assert.equal(draft2019.fieldDeprecated(['inherited']), false);
});

test('draft 2020-12 reads prefixItems with items, $dynamicRef to its $dynamicAnchor, and deprecated through a $ref', () => {
  const draft2020 = schemaParserFor({
    $schema: DRAFT_2020_12_URI,
    properties: {
      pair: { prefixItems: [{ type: 'string' }], items: { type: 'number' } },
      closed: { prefixItems: [{ type: 'string' }], items: false },
      dynamic: { $dynamicRef: '#mock-node' },
      retired: { $ref: '#/$defs/retired' },
    },
    $defs: {
      node: { $dynamicAnchor: 'mock-node', properties: { label: { type: 'string' } } },
      retired: { type: 'string', deprecated: true },
    },
  });
  assert.equal(draft2020.nodeAt(['pair', 0]).type, 'string');
  assert.equal(draft2020.nodeAt(['pair', 5]).type, 'number');
  assert.equal(draft2020.nodeAt(['closed', 1]), null);
  assert.equal(draft2020.nodeAt(['dynamic', 'label']).type, 'string');
  assert.equal(draft2020.fieldDeprecated(['retired']), true);
});

test('an opt-out is validated by the validator of the schema\'s draft', () => {
  const containsAtLeastNone = { contains: {}, minContains: 0 };
  const schemas = {
    'mock-draft-07': { $schema: DRAFT_07_URI, properties: { hosts: containsAtLeastNone } },
    'mock-draft-2020-12': { $schema: DRAFT_2020_12_URI, properties: { hosts: containsAtLeastNone } },
  };
  const checks = createSchemaChecks((schemaHash) => schemas[schemaHash]);
  assert.ok(checks.nodeCheck('mock-draft-07', ['hosts']).optOutFailures([]).length > 0);
  assert.deepEqual(checks.nodeCheck('mock-draft-2020-12', ['hosts']).optOutFailures([]), []);
  const unread = createSchemaChecks(() => ({ $schema: 'https://json-schema.org/draft/mock-future/schema' }));
  assert.equal(unread.nodeCheck('mock-future-draft', ['hosts']).state, 'no_schema');
});

const branchSchema = {
  $schema: DRAFT_2020_12_URI,
  $defs: { 'Mock::Bucket': { const: 'Mock::Bucket' } },
  properties: {
    mockthings: {
      additionalProperties: {
        properties: { Type: { enum: ['Mock::Bucket', 'Mock::Queue'] } },
        allOf: [
          {
            if: { properties: { Type: { $ref: '#/$defs/Mock::Bucket' } }, required: ['Type'] },
            then: {
              properties: { Properties: { properties: { BucketName: { type: 'string', description: 'The bucket name.' } } } },
              required: ['Properties'],
            },
            else: { properties: { Properties: { properties: { QueueName: { enum: ['mock-a', 'mock-b'] } } } } },
          },
        ],
      },
    },
  },
};

test('a document selects the branch its value meets, and without a value every branch is read', () => {
  const bucket = { mockthings: { one: { Type: 'Mock::Bucket' } } };
  const queue = { mockthings: { one: { Type: 'Mock::Queue' } } };
  const bucketParser = schemaParserForDocument(branchSchema, bucket);
  const queueParser = schemaParserForDocument(branchSchema, queue);
  const anyParser = schemaParserForDocument(branchSchema, undefined);
  const propertiesPath = ['mockthings', 'one', 'Properties'];
  assert.deepEqual(Object.keys(bucketParser.fieldsAt(propertiesPath)), ['BucketName']);
  assert.deepEqual(Object.keys(queueParser.fieldsAt(propertiesPath)), ['QueueName']);
  assert.deepEqual(Object.keys(anyParser.fieldsAt(propertiesPath)).sort(), ['BucketName', 'QueueName']);
  assert.deepEqual(bucketParser.requiredKeysAt(['mockthings', 'one']), ['Properties']);
  assert.deepEqual(queueParser.requiredKeysAt(['mockthings', 'one']), []);
  assert.equal(bucketParser.fieldDescription([...propertiesPath, 'BucketName']), 'The bucket name.');
  assert.equal(queueParser.fieldDescription([...propertiesPath, 'BucketName']), null);
  assert.deepEqual(queueParser.valueFormsAt([...propertiesPath, 'QueueName']), [{ enum: ['mock-a', 'mock-b'] }]);
  const unknown = schemaParserForDocument(branchSchema, { mockthings: { one: {} } });
  assert.deepEqual(Object.keys(unknown.fieldsAt(propertiesPath)), ['QueueName']);
  const anywhere = schemaParserForDocument(branchSchema, { mockthings: {} });
  assert.deepEqual(Object.keys(anywhere.fieldsAt(propertiesPath)).sort(), ['BucketName', 'QueueName']);
});

test('a field a branch restates without a description keeps the description its base states', () => {
  const schema = {
    $schema: DRAFT_2020_12_URI,
    $defs: { 'Mock::Bucket': { properties: { BucketName: { type: 'string' } } } },
    properties: {
      mockthing: {
        properties: {
          Type: { type: 'string' },
          Properties: { type: 'object', description: 'The mock properties.' },
          Tags: { type: 'object', description: 'The mock tags.' },
        },
        allOf: [
          {
            if: { properties: { Type: { const: 'Mock::Bucket' } }, required: ['Type'] },
            then: {
              properties: {
                Properties: { $ref: '#/$defs/Mock::Bucket' },
                Tags: { type: 'object', description: 'The bucket tags.' },
              },
            },
          },
        ],
      },
    },
  };
  const parser = schemaParserForDocument(schema, { mockthing: { Type: 'Mock::Bucket' } });
  assert.equal(parser.fieldDescription(['mockthing', 'Properties']), 'The mock properties.');
  assert.equal(parser.fieldsAt(['mockthing']).Properties.description, 'The mock properties.');
  assert.deepEqual(Object.keys(parser.fieldsAt(['mockthing', 'Properties'])), ['BucketName']);
  assert.equal(parser.fieldDescription(['mockthing', 'Tags']), 'The bucket tags.');
});

test('a value form under a branch is one form when the document selects it and an alternative of each branch without', () => {
  const schema = {
    $schema: DRAFT_2020_12_URI,
    properties: {
      mode: { type: 'string' },
      size: {
        if: { type: 'string' },
        then: { enum: ['small', 'large'] },
        else: { enum: [1, 2] },
        anyOf: [{ description: 'first' }, { description: 'second' }],
      },
    },
  };
  assert.deepEqual(
    schemaParserForDocument(schema, { size: 'small' }).valueFormsAt(['size']).map((form) => form.enum),
    [['small', 'large'], ['small', 'large']],
  );
  assert.deepEqual(
    schemaParserForDocument(schema, undefined).valueFormsAt(['size']).map((form) => form.enum),
    [['small', 'large'], [1, 2], ['small', 'large'], [1, 2]],
  );
});

test('a field\'s children come from the alternatives whose type admits the document\'s value, '
  + 'never their requiredness', () => {
  const schema = {
    $schema: DRAFT_2020_12_URI,
    $defs: {
      mock_key: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', description: 'The mock key name.' }, kind: { type: 'string' } },
      },
    },
    properties: {
      keys: {
        oneOf: [
          { type: 'array', items: { $ref: '#/$defs/mock_key' } },
          { type: 'object', required: ['mode'], properties: { mode: { type: 'string' } } },
          { required: ['untyped'], properties: { untyped: { type: 'string' } } },
        ],
      },
      size: { anyOf: [{ type: 'number', properties: { mock: {} } }, { $ref: '#/$defs/mock_key' }] },
    },
  };
  const listed = schemaParserForDocument(schema, { keys: [{ name: 'mock' }], size: 3 });
  assert.deepEqual(Object.keys(listed.fieldsAt(['keys', 0])).sort(), ['kind', 'name']);
  assert.deepEqual(listed.requiredKeysAt(['keys', 0]), ['name']);
  assert.equal(listed.fieldDescription(['keys', 0, 'name']), 'The mock key name.');
  assert.deepEqual(Object.keys(listed.fieldsAt(['size'])), ['mock']);
  const mapped = schemaParserForDocument(schema, { keys: { mode: 'mock' }, size: { name: 'mock' } });
  assert.deepEqual(Object.keys(mapped.fieldsAt(['keys'])), ['mode']);
  assert.deepEqual(mapped.requiredKeysAt(['keys']), []);
  assert.deepEqual(Object.keys(mapped.fieldsAt(['size'])).sort(), ['kind', 'name']);
  assert.deepEqual(Object.keys(schemaParserForDocument(schema, { keys: 'mock' }).fieldsAt(['keys'])), []);
  assert.deepEqual(Object.keys(schemaParserFor(schema).fieldsAt(['keys'])), []);
});

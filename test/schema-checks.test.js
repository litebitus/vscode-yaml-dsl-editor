const test = require('node:test');
const assert = require('node:assert/strict');
const { FAILURE_KINDS, NODE_STATES, createSchemaChecks } = require('../lib/schema-checks');
const { schemaParserFor } = require('../lib/json-schema');

const schemaNodeAt = (root, path) => schemaParserFor(root).nodeAt(path);

const mockTree = {
  type: 'object',
  properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/definitions/mock_tree' } } },
};

const mockSchemas = {
  'mock-base': {
    type: 'object',
    additionalProperties: false,
    definitions: { mock_tree: mockTree },
    properties: {
      resource: {
        type: 'object',
        description: '[optional] mock resource',
        properties: {
          description: { type: 'string', description: 'a field named description' },
          tree: { $ref: '#/definitions/mock_tree' },
          tags: { type: 'object' },
        },
      },
      open: {},
    },
  },
  'mock-reworded': {
    type: 'object',
    additionalProperties: false,
    definitions: { mock_tree: mockTree },
    properties: {
      resource: {
        type: 'object',
        title: 'reworded',
        description: '[optional] reworded mock resource',
        properties: {
          description: { type: 'string', $comment: 'reworded' },
          tree: { $ref: '#/definitions/mock_tree', examples: [{ name: 'mock' }] },
          tags: { type: 'object' },
        },
      },
      open: {},
    },
  },
  'mock-renamed-field': {
    type: 'object',
    additionalProperties: false,
    definitions: { mock_tree: mockTree },
    properties: {
      resource: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          tree: { $ref: '#/definitions/mock_tree' },
          tags: { type: 'object' },
        },
      },
      open: {},
    },
  },
};

function checksOf() {
  return createSchemaChecks((schemaHash) => mockSchemas[schemaHash] || null);
}

test('the node at a path follows properties and refs, is open where the schema allows any key, and absent where it forbids one', () => {
  const schema = mockSchemas['mock-base'];
  assert.equal(schemaNodeAt(schema, ['resource', 'tree', 'children', 0, 'name']).type, 'string');
  assert.equal(schemaNodeAt(schema, ['resource', 'anything']), true);
  assert.equal(schemaNodeAt(schema, ['open', 'anything', 3]), true);
  assert.equal(schemaNodeAt(schema, ['unknown']), null);
});

test('annotations do not change a node\'s fingerprint, a field named like one does', () => {
  const checks = checksOf();
  const base = checks.nodeCheck('mock-base', ['resource']);
  assert.equal(base.state, NODE_STATES.constrained);
  assert.equal(checks.nodeCheck('mock-reworded', ['resource']).fingerprint, base.fingerprint);
  assert.notEqual(checks.nodeCheck('mock-renamed-field', ['resource']).fingerprint, base.fingerprint);
  assert.equal(checks.nodeCheck('mock-base', ['resource']).fingerprint, base.fingerprint);
});

test('a recursive ref is fingerprinted without looping', () => {
  const checks = checksOf();
  const tree = checks.nodeCheck('mock-base', ['resource', 'tree']);
  assert.equal(tree.fingerprint, checks.nodeCheck('mock-reworded', ['resource', 'tree']).fingerprint);
});

test('a path the schema forbids, an open path and a missing schema each have their own state', () => {
  const checks = checksOf();
  assert.equal(checks.nodeCheck('mock-base', ['unknown']).state, NODE_STATES.notAllowed);
  assert.equal(checks.nodeCheck('mock-base', ['open']).state, NODE_STATES.open);
  assert.equal(checks.nodeCheck(null, ['resource']).state, NODE_STATES.noSchema);
  assert.equal(checks.nodeCheck('mock-missing', ['resource']).state, NODE_STATES.noSchema);
});

const messageFailure = (text) => ({ kind: FAILURE_KINDS.message, text, alternatives: [] });

test('the opt-out is checked against the node and fails with the schema\'s own messages', () => {
  const checks = checksOf();
  assert.deepEqual(checks.nodeCheck('mock-base', ['resource']).optOutFailures(), []);
  assert.deepEqual(checks.nodeCheck('mock-base', ['open']).optOutFailures(), []);
  assert.deepEqual(checks.nodeCheck('mock-base', ['resource', 'description']).optOutFailures(), [
    messageFailure('must be string'),
  ]);
  assert.deepEqual(checks.nodeCheck('mock-base', ['unknown']).optOutFailures(), [
    messageFailure('the schema does not allow it'),
  ]);
  assert.deepEqual(checks.nodeCheck(null, ['resource']).optOutFailures(), []);
});

const alternativeSchemas = {
  'mock-alternatives': {
    type: 'object',
    definitions: {
      mock_call_form: {
        description: '[optional] A mock object carrying a call key.',
        type: 'object',
        not: { propertyNames: { not: { pattern: '^call ' } } },
      },
    },
    properties: {
      any_form: {
        type: 'object',
        anyOf: [{ required: ['size', 'kind'] }, { $ref: '#/definitions/mock_call_form' }],
      },
      one_form: { oneOf: [{ type: 'object' }, { not: { type: 'string' } }] },
      undescribed: { allOf: [{ not: { type: 'array' } }, { not: { type: 'object' } }] },
      forbidden: false,
    },
  },
};

test('a failed anyOf lists its alternatives, a not failure reads as the description it guards', () => {
  const checks = createSchemaChecks((schemaHash) => alternativeSchemas[schemaHash] || null);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['any_form']).optOutFailures(), [{
    kind: FAILURE_KINDS.alternatives,
    text: null,
    alternatives: [
      [messageFailure("must have required property 'size'"), messageFailure("must have required property 'kind'")],
      [messageFailure('A mock object carrying a call key.')],
    ],
  }]);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['one_form']).optOutFailures(), [
    messageFailure('must match exactly one alternative, matches 2'),
  ]);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['undescribed']).optOutFailures(), [
    messageFailure('must NOT be valid'),
  ]);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['forbidden']).optOutFailures(), [
    messageFailure('the schema does not allow it'),
  ]);
});

function markedSchemaOf(resource) {
  return {
    type: 'object',
    definitions: { mock_value: { type: 'string', description: 'a value shape, never a marker' } },
    properties: { resource },
  };
}

const markedSchemas = {
  'marker-adds': markedSchemaOf({
    type: 'object',
    properties: { name: { $ref: '#/definitions/mock_value', description: '[required] mock name' } },
  }),
  'marker-removes': markedSchemaOf({
    type: 'object',
    required: ['name', 'kind'],
    properties: {
      name: { $ref: '#/definitions/mock_value', description: '[optional] mock name' },
      kind: { type: 'string' },
    },
  }),
  'marker-removes-in-branch': markedSchemaOf({
    type: 'object',
    anyOf: [{ required: ['name'] }, { required: ['kind'] }],
    properties: {
      name: { type: 'string', description: ' [optional] mock name' },
      kind: { type: 'string', description: '[optional] mock kind' },
    },
  }),
  'marker-conditional': markedSchemaOf({
    type: 'object',
    properties: {
      name: { type: 'string', description: '[~required] mock name' },
      kind: { type: 'string', description: '[optional] mock kind' },
    },
  }),
  'marker-conditional-plain': markedSchemaOf({
    type: 'object',
    properties: {
      name: { type: 'string', description: '[optional] mock name' },
      kind: { type: 'string', description: '[optional] mock kind' },
    },
  }),
};

function markedChecksOf() {
  return createSchemaChecks((schemaHash) => markedSchemas[schemaHash] || null);
}

test('a field\'s requirement marker decides its key over the parent\'s required array', () => {
  const checks = markedChecksOf();
  assert.deepEqual(checks.nodeCheck('marker-adds', ['resource']).optOutFailures(), [
    messageFailure("must have required property 'name'"),
  ]);
  assert.deepEqual(checks.nodeCheck('marker-removes', ['resource']).optOutFailures(), [
    messageFailure("must have required property 'kind'"),
  ]);
  assert.deepEqual(checks.nodeCheck('marker-removes-in-branch', ['resource']).optOutFailures(), []);
});

test('a conditionally required field is reported, not failed, and its marker counts in the fingerprint', () => {
  const checks = markedChecksOf();
  const conditional = checks.nodeCheck('marker-conditional', ['resource']);
  assert.deepEqual(conditional.optOutFailures(), []);
  assert.deepEqual(conditional.conditionallyRequiredFields(), ['resource.name']);
  const plain = checks.nodeCheck('marker-conditional-plain', ['resource']);
  assert.deepEqual(plain.conditionallyRequiredFields(), []);
  assert.notEqual(plain.fingerprint, conditional.fingerprint);
  assert.deepEqual(checks.nodeCheck(null, ['resource']).conditionallyRequiredFields(), []);
});

const validatedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  $defs: {
    number_or_ref: {
      description: 'A literal number, or a `ref` resolving to one. More words.',
      oneOf: [{ type: 'number' }, { type: 'string', pattern: '^ref ' }],
    },
  },
  properties: {
    mocktype: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['legacy_listed', 'listed'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '[required] The mock name.' },
          listed: { type: 'string' },
          legacy_listed: { type: 'string', description: '[optional] Listed, marked optional.' },
          mode: { enum: ['fast', 'slow'] },
          size: { $ref: '#/$defs/number_or_ref' },
          count: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^ref ' }] },
          enabled: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          ratio: { type: 'number', minimum: 1 },
        },
      },
    },
  },
};

function documentMessages(value) {
  const checks = createSchemaChecks((schemaHash) => (schemaHash === 'mock-validated' ? validatedSchema : null));
  return checks.documentProblems('mock-validated', value).map(({ path, message }) => [path, message]);
}

test('a document\'s validation errors are worded by field, the markers deciding which fields are required', () => {
  assert.deepEqual(documentMessages({ mocktype: { primary: {} } }), [
    [['mocktype', 'primary'], '`listed` is required'],
    [['mocktype', 'primary'], '`name` is required'],
  ]);
  const primary = {
    name: 'mock',
    listed: 'mock',
    mode: 'medium',
    size: 'large',
    count: 'many',
    enabled: null,
    tags: ['mock-tag', 2],
    ratio: 0,
    mock_field: 1,
  };
  assert.deepEqual(documentMessages({ mocktype: { primary }, other: 1 }), [
    [['other'], '`other` is not a field of the document'],
    [['mocktype', 'primary', 'mock_field'], '`mock_field` is not a field of `primary`'],
    [['mocktype', 'primary', 'mode'], '`mode` must be one of `"fast"`, `"slow"`'],
    [['mocktype', 'primary', 'size'], '`size` must be a literal number, or a `ref` resolving to one'],
    [['mocktype', 'primary', 'count'], '`count` matches none of its allowed forms'],
    [['mocktype', 'primary', 'enabled'], '`enabled` must be boolean'],
    [['mocktype', 'primary', 'tags', 1], '`tags[1]` must be string'],
    [['mocktype', 'primary', 'ratio'], '`ratio` must be >= 1'],
  ]);
  assert.deepEqual(createSchemaChecks(() => null).documentProblems(null, {}), []);
});

test('a key failing its map\'s key schema is marked on the key, and one message repeated on a path is reported once', () => {
  const keyedSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      mocktype: { type: 'object', propertyNames: { pattern: '^[a-z_]+$' } },
      settings: {
        type: 'object',
        allOf: [
          { if: { required: ['mode'] }, then: { not: { required: ['size'] } } },
          { if: { required: ['mode'] }, then: { not: { required: ['size'] } } },
        ],
      },
    },
  };
  const checks = createSchemaChecks(() => keyedSchema);
  const messages = checks.documentProblems('mock-keyed', {
    mocktype: { 'mock-bad': {} },
    settings: { mode: 'fast', size: 1 },
  }).map(({ path, message }) => [path, message]);
  assert.deepEqual(messages, [
    [['mocktype', 'mock-bad'], '`mock-bad` is not a valid key of `mocktype`'],
    [['settings'], '`settings` must NOT be valid'],
  ]);
});

test('a value none of whose forms holds reads as the described definition its field refers to, in a schema with an $id', () => {
  const identifiedSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://example.test/mock.schema.json',
    definitions: {
      number_or_ref: {
        description: 'A literal number, or a `ref` resolving to one.',
        oneOf: [{ type: 'number' }, { type: 'string', pattern: '^ref ' }],
      },
    },
    properties: {
      threshold: { $ref: '#/definitions/number_or_ref', description: '[optional] The mock threshold.' },
    },
  };
  const checks = createSchemaChecks(() => identifiedSchema);
  const messages = checks.documentProblems('mock-identified', { threshold: 'mock-high' }).map(({ message }) => message);
  assert.deepEqual(messages, ['`threshold` must be a literal number, or a `ref` resolving to one']);
});

test('a required list inside not or if is a condition the markers leave as written', () => {
  const conditionSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      group: {
        type: 'object',
        properties: {
          node_type: { type: 'string' },
          count: { type: 'integer', description: '[optional] Mock count.' },
        },
        allOf: [{ if: { properties: { node_type: { const: 'master' } } }, then: { not: { required: ['count'] } } }],
      },
    },
  };
  const checks = createSchemaChecks(() => conditionSchema);
  assert.deepEqual(checks.documentProblems('mock-condition', { group: { node_type: 'master' } }), []);
  const counted = checks.documentProblems('mock-condition', { group: { node_type: 'master', count: 1 } });
  assert.deepEqual(counted.map(({ path, message }) => [path, message]), [[['group'], '`group` must NOT be valid']]);
});

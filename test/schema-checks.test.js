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
      entry: {
        type: 'object',
        description: '[optional] mock entry',
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
      entry: {
        type: 'object',
        title: 'reworded',
        description: '[optional] reworded mock entry',
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
      entry: {
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
  assert.equal(schemaNodeAt(schema, ['entry', 'tree', 'children', 0, 'name']).type, 'string');
  assert.equal(schemaNodeAt(schema, ['entry', 'anything']), true);
  assert.equal(schemaNodeAt(schema, ['open', 'anything', 3]), true);
  assert.equal(schemaNodeAt(schema, ['unknown']), null);
});

test('annotations do not change a node\'s fingerprint, a field named like one does', () => {
  const checks = checksOf();
  const base = checks.nodeCheck('mock-base', ['entry']);
  assert.equal(base.state, NODE_STATES.constrained);
  assert.equal(checks.nodeCheck('mock-reworded', ['entry']).sameNodeAs(base), true);
  assert.equal(checks.nodeCheck('mock-renamed-field', ['entry']).sameNodeAs(base), false);
  assert.equal(checks.nodeCheck('mock-base', ['entry']).sameNodeAs(base), true);
});

test('a recursive ref is fingerprinted without looping', () => {
  const checks = checksOf();
  const tree = checks.nodeCheck('mock-base', ['entry', 'tree']);
  assert.equal(tree.sameNodeAs(checks.nodeCheck('mock-reworded', ['entry', 'tree'])), true);
});

test('a node of one schema is the same node as itself without a fingerprint, '
  + 'and nodes of different schemas, or no schema, are compared by state and fingerprint', () => {
  const unhashable = { type: 'object', properties: { entry: { type: 'object', properties: { size: { const: 1n } } } } };
  const checks = createSchemaChecks((schemaHash) => ({ ...mockSchemas, 'mock-unhashable': unhashable })[schemaHash]);
  const entry = checks.nodeCheck('mock-unhashable', ['entry']);
  assert.equal(entry.sameNodeAs(checks.nodeCheck('mock-unhashable', ['entry'])), true);
  assert.throws(() => entry.fingerprint(), /BigInt/);
  const tags = checks.nodeCheck('mock-base', ['entry', 'tags']);
  assert.equal(checks.nodeCheck('mock-base', ['entry']).sameNodeAs(tags), false);
  assert.equal(checks.nodeCheck(null, ['entry']).sameNodeAs(checks.nodeCheck('mock-missing', ['entry'])), true);
  assert.equal(checks.nodeCheck(null, ['entry']).sameNodeAs(checks.nodeCheck('mock-base', ['entry'])), false);
  assert.equal(checks.nodeCheck('mock-base', ['open']).sameNodeAs(checks.nodeCheck('mock-reworded', ['open'])), true);
});

test('a path the schema forbids, an open path and a missing schema each have their own state', () => {
  const checks = checksOf();
  assert.equal(checks.nodeCheck('mock-base', ['unknown']).state, NODE_STATES.notAllowed);
  assert.equal(checks.nodeCheck('mock-base', ['open']).state, NODE_STATES.open);
  assert.equal(checks.nodeCheck(null, ['entry']).state, NODE_STATES.noSchema);
  assert.equal(checks.nodeCheck('mock-missing', ['entry']).state, NODE_STATES.noSchema);
});

const messageFailure = (text) => ({ kind: FAILURE_KINDS.message, text, alternatives: [] });

test('the opt-out is checked against the node and fails with the schema\'s own messages', () => {
  const checks = checksOf();
  assert.deepEqual(checks.nodeCheck('mock-base', ['entry']).optOutFailures(), []);
  assert.deepEqual(checks.nodeCheck('mock-base', ['open']).optOutFailures(), []);
  assert.deepEqual(checks.nodeCheck('mock-base', ['entry', 'description']).optOutFailures(), [
    messageFailure('must be string'),
  ]);
  assert.deepEqual(checks.nodeCheck('mock-base', ['unknown']).optOutFailures(), [
    messageFailure('the schema does not allow it'),
  ]);
  assert.deepEqual(checks.nodeCheck(null, ['entry']).optOutFailures(), []);
});

test('a node\'s own keywords resolve their references anywhere in the schema, not only in its definitions', () => {
  const schema = {
    type: 'object',
    properties: {
      shared_name: { type: 'string' },
      entry: { type: 'object', properties: { name: { $ref: '#/properties/shared_name' } } },
    },
  };
  const checks = createSchemaChecks((schemaHash) => (schemaHash === 'mock-shared' ? schema : null));
  const entry = checks.nodeCheck('mock-shared', ['entry']);
  assert.deepEqual(entry.optOutFailures({ name: 'mock-name' }), []);
  assert.deepEqual(entry.optOutFailures({ name: 1 }), [messageFailure('must be string')]);
});

test('an opt-out is checked against the branch its condition selects, the other branch never compiled', () => {
  const schema = {
    type: 'object',
    properties: {
      entry: {
        type: 'object',
        if: { required: ['kind'], properties: { kind: { const: 'mock-bucket' } } },
        then: { required: ['bucket'], properties: { broken: { type: 'string', pattern: '(' } } },
        else: { required: ['queue'] },
      },
      bare: { if: { required: ['kind'] }, then: { required: ['bucket'] } },
    },
  };
  const checks = createSchemaChecks((schemaHash) => (schemaHash === 'mock-branches' ? schema : null));
  const entry = checks.nodeCheck('mock-branches', ['entry']);
  assert.deepEqual(entry.optOutFailures({}), [messageFailure("must have required property 'queue'")]);
  assert.deepEqual(entry.optOutFailures({ kind: 'mock-bucket', bucket: 'mock' }), [
    messageFailure('the schema cannot be compiled\n\n```text\nInvalid regular expression: /(/u: Unterminated group\n```'),
  ]);
  const bare = checks.nodeCheck('mock-branches', ['bare']);
  assert.deepEqual(bare.optOutFailures({}), []);
  assert.deepEqual(bare.optOutFailures({ kind: 'mock' }), [messageFailure("must have required property 'bucket'")]);
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

test('a failed anyOf lists its alternatives, a not failure carries the description it guards as its schema note', () => {
  const checks = createSchemaChecks((schemaHash) => alternativeSchemas[schemaHash] || null);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['any_form']).optOutFailures(), [{
    kind: FAILURE_KINDS.alternatives,
    text: null,
    alternatives: [
      [messageFailure("must have required property 'size'"), messageFailure("must have required property 'kind'")],
      [{
        ...messageFailure('matches a form that is not allowed'),
        schemaNote: '[optional] A mock object carrying a call key.',
      }],
    ],
  }]);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['one_form']).optOutFailures(), [
    messageFailure('must match exactly one alternative, matches 2'),
  ]);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['undescribed']).optOutFailures(), [
    messageFailure('matches a form that is not allowed'),
  ]);
  assert.deepEqual(checks.nodeCheck('mock-alternatives', ['forbidden']).optOutFailures(), [
    messageFailure('the schema does not allow it'),
  ]);
});

function markedSchemaOf(entry) {
  return {
    type: 'object',
    definitions: { mock_value: { type: 'string', description: 'a value shape, never a marker' } },
    properties: { entry },
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
  'marker-leaves-branch-form': markedSchemaOf({
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

test('a field\'s requiredness marker decides its key over the parent\'s required array', () => {
  const checks = markedChecksOf();
  assert.deepEqual(checks.nodeCheck('marker-adds', ['entry']).optOutFailures(), [
    messageFailure("must have required property 'name'"),
  ]);
  assert.deepEqual(checks.nodeCheck('marker-removes', ['entry']).optOutFailures(), [
    messageFailure("must have required property 'kind'"),
  ]);
  assert.deepEqual(checks.nodeCheck('marker-leaves-branch-form', ['entry']).optOutFailures(), [{
    kind: FAILURE_KINDS.alternatives,
    text: null,
    alternatives: [
      [messageFailure("must have required property 'name'")],
      [messageFailure("must have required property 'kind'")],
    ],
  }]);
});

test('a conditionally required field is reported, not failed, and its marker counts in the fingerprint', () => {
  const checks = markedChecksOf();
  const conditional = checks.nodeCheck('marker-conditional', ['entry']);
  assert.deepEqual(conditional.optOutFailures(), []);
  assert.deepEqual(conditional.conditionallyRequiredFields(), ['entry.name']);
  const plain = checks.nodeCheck('marker-conditional-plain', ['entry']);
  assert.deepEqual(plain.conditionallyRequiredFields(), []);
  assert.equal(plain.sameNodeAs(conditional), false);
  assert.deepEqual(checks.nodeCheck(null, ['entry']).conditionallyRequiredFields(), []);
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
    [['other'], '`other` is not defined in the schema'],
    [['mocktype', 'primary', 'mock_field'], '`mock_field` is not defined in the schema'],
    [['mocktype', 'primary', 'mode'], '`mode` must be one of `"fast"`, `"slow"`'],
    [['mocktype', 'primary', 'size'], '`size` matches none of its allowed forms'],
    [['mocktype', 'primary', 'count'], '`count` matches none of its allowed forms'],
    [['mocktype', 'primary', 'enabled'], '`enabled` must be `boolean`'],
    [['mocktype', 'primary', 'tags', 1], '`tags[1]` must be `string`'],
    [['mocktype', 'primary', 'ratio'], '`ratio` must be >= `1`'],
  ]);
  assert.deepEqual(createSchemaChecks(() => null).documentProblems(null, {}), []);
});

test('a schema that cannot be compiled is the editor\'s sentence, then the compiler\'s text as written in a code block', () => {
  const draft07 = 'http://json-schema.org/draft-07/schema#';
  assert.deepEqual(problemsOfSchema({ mock_label: { type: 'string', pattern: '(_mock_' } }, {}, draft07), [
    [[], 'the schema cannot be compiled\n\n```text\nInvalid regular expression: /(_mock_/u: Unterminated group\n```'],
  ]);
  assert.deepEqual(problemsOfSchema({ mock_label: { $ref: '#/$defs/mock-missing' } }, {}), [
    [[], 'the schema cannot be compiled\n\n```text\ncan\'t resolve reference #/$defs/mock-missing from id #\n```'],
  ]);
});

function problemsOfSchema(schemaProperties, value, schemaUri = 'https://json-schema.org/draft/2020-12/schema') {
  const schema = { $schema: schemaUri, properties: schemaProperties };
  const checks = createSchemaChecks((schemaHash) => (schemaHash === 'mock-worded' ? schema : null));
  return checks.documentProblems('mock-worded', value)
    .map(({ path, message, schemaNote }) => (schemaNote ? [path, message, schemaNote] : [path, message]));
}

test('a value failing a not matches a form that is not allowed, the description of the schema it rules out its note', () => {
  const problems = problemsOfSchema({
    described: { not: { description: 'Mock: no `color` here.', required: ['color'] } },
    undescribed: { not: { required: ['color'] } },
  }, { described: { color: 'red' }, undescribed: { color: 'red' } });
  assert.deepEqual(problems, [
    [['described'], '`described` matches a form that is not allowed', 'Mock: no `color` here.'],
    [['undescribed'], '`undescribed` matches a form that is not allowed'],
  ]);
});

test('a value no form holds matches none of its allowed forms, the described definition its note as written', () => {
  const definedSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      mock_forms: {
        description: '[optional] A literal number, or a `ref` resolving to one. More words.',
        anyOf: [{ type: 'number' }, { type: 'string', pattern: '^ref ' }],
      },
    },
    properties: {
      described: { $ref: '#/$defs/mock_forms' },
      borrowed: { $ref: '#/properties/mock_field' },
      mock_field: {
        description: 'The mock field.',
        anyOf: [{ type: 'number' }, { type: 'boolean' }],
      },
      undescribed: { oneOf: [{ type: 'number' }, { type: 'boolean' }] },
    },
  };
  const checks = createSchemaChecks((schemaHash) => (schemaHash === 'mock-defined' ? definedSchema : null));
  const problems = checks.documentProblems('mock-defined', { described: 'mock', borrowed: 'mock', undescribed: 'mock' })
    .map(({ path, message, schemaNote }) => (schemaNote ? [path, message, schemaNote] : [path, message]));
  assert.deepEqual(problems, [
    [
      ['described'],
      '`described` matches none of its allowed forms',
      '[optional] A literal number, or a `ref` resolving to one. More words.',
    ],
    [['borrowed'], '`borrowed` matches none of its allowed forms'],
    [['undescribed'], '`undescribed` matches none of its allowed forms'],
  ]);
});

test('every value a validation error writes is fenced, worded from the failed keyword', () => {
  const problems = problemsOfSchema({
    constant: { const: 'mock' },
    exclusive: { exclusiveMaximum: 2 },
    multiple: { multipleOf: 5 },
    short: { minLength: 3 },
    long: { maxLength: 1 },
    few: { minItems: 3 },
    many: { maxItems: 1 },
    sparse: { minProperties: 2 },
    dense: { maxProperties: 0 },
    tuple: { prefixItems: [{}, {}], items: false },
    unevaluated: { prefixItems: [{}], unevaluatedItems: false },
    patterned: { pattern: '^x' },
    ticked: { pattern: '`a``' },
    unique: { uniqueItems: true },
    containing: { contains: { const: 1 } },
    bounded: { contains: { const: 1 }, minContains: 1, maxContains: 2 },
    forbidden: false,
    typed: { type: ['string', 'number'] },
  }, {
    constant: 'other',
    exclusive: 2,
    multiple: 7,
    short: 'ab',
    long: 'ab',
    few: [1],
    many: [1, 2],
    sparse: {},
    dense: { mock: 1 },
    tuple: [1, 2, 3],
    unevaluated: [1, 2],
    patterned: 'y',
    ticked: 'y',
    unique: [2, 1, 1, 2],
    containing: [2],
    bounded: [1, 1, 1],
    forbidden: 1,
    typed: true,
  });
  assert.deepEqual(problems.map(([, message]) => message), [
    '`constant` must be `"mock"`',
    '`exclusive` must be < `2`',
    '`multiple` must be multiple of `5`',
    '`short` must NOT have fewer than `3` characters',
    '`long` must NOT have more than `1` characters',
    '`few` must NOT have fewer than `3` items',
    '`many` must NOT have more than `1` items',
    '`sparse` must NOT have fewer than `2` properties',
    '`dense` must NOT have more than `0` properties',
    '`tuple` must NOT have more than `2` items',
    '`unevaluated` must NOT have more than `1` items',
    '`patterned` must match pattern `^x`',
    '`ticked` must match pattern ``` `a`` ```',
    '`unique` must NOT have duplicate items (items ## 2 and 1 are identical)',
    '`containing` must contain at least `1` valid item(s)',
    '`bounded` must contain at least `1` and no more than `2` valid item(s)',
    '`forbidden` boolean schema is false',
    '`typed` must be `string` or `number`',
  ]);
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
    [['settings'], '`settings` matches a form that is not allowed'],
  ]);
});

test('a value none of whose forms holds is noted with the described definition its field refers to, in a schema with an $id', () => {
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
  const problems = checks.documentProblems('mock-identified', { threshold: 'mock-high' })
    .map(({ message, schemaNote }) => [message, schemaNote]);
  assert.deepEqual(problems, [
    ['`threshold` matches none of its allowed forms', 'A literal number, or a `ref` resolving to one.'],
  ]);
});

test('a dependency its key does not meet is marked on that key, worded as what the key needs', () => {
  const dependentSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      mock_call_form: { type: 'object', not: { propertyNames: { not: { pattern: ' fn\\.' } } } },
      mock_entry: {
        type: 'object',
        properties: {
          queue: { type: 'string', description: '[optional] Mock queue.' },
          role: { type: 'string', description: '[optional] Mock role.' },
          label: { type: 'string', description: '[optional] Mock label.' },
          size: { type: 'integer', description: '[optional] Mock size.' },
        },
        dependentRequired: { label: ['size'] },
        dependentSchemas: {
          queue: { anyOf: [{ required: ['role'] }, { $ref: '#/$defs/mock_call_form' }] },
          role: { anyOf: [{ required: ['queue'] }, { $ref: '#/$defs/mock_call_form' }] },
        },
      },
    },
    properties: { mocktype: { type: 'object', additionalProperties: { $ref: '#/$defs/mock_entry' } } },
  };
  const checks = createSchemaChecks(() => dependentSchema);
  const messagesOf = (primary) => checks.documentProblems('mock-dependent', { mocktype: { primary } })
    .map(({ path, message }) => [path, message]);
  assert.deepEqual(messagesOf({ queue: 'mock-queue', role: 'mock-role' }), []);
  assert.deepEqual(messagesOf({ queue: 'mock-queue', label: 'mock' }), [
    [['mocktype', 'primary', 'label'], '`label` needs `size`'],
    [['mocktype', 'primary', 'queue'], '`queue` needs `role`, or a `mock_call_form`'],
  ]);
  assert.deepEqual(messagesOf({ role: 'mock-role' }), [
    [['mocktype', 'primary', 'role'], '`role` needs `queue`, or a `mock_call_form`'],
  ]);
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
  assert.deepEqual(counted.map(({ path, message }) => [path, message]), [
    [['group'], '`group` matches a form that is not allowed'],
  ]);
});

test('a required list inside an anyOf or oneOf branch selects a form the markers leave as written', () => {
  const formSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      one_of: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '[optional] Mock host.' },
          host_ssm: { type: 'string', description: '[optional] Mock host parameter.' },
        },
        oneOf: [{ required: ['host'] }, { required: ['host_ssm'] }],
      },
      any_of: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '[optional] Mock host.' },
          host_ssm: { type: 'string', description: '[optional] Mock host parameter.' },
        },
        anyOf: [{ required: ['host'] }, { required: ['host_ssm'] }],
      },
    },
  };
  const checks = createSchemaChecks(() => formSchema);
  const messagesOf = (document) => checks.documentProblems('mock-form', document)
    .map(({ path, message }) => [path, message]);
  assert.deepEqual(messagesOf({ one_of: { host: 'mock-host' }, any_of: { host_ssm: '/mock/host' } }), []);
  assert.deepEqual(messagesOf({ one_of: { host: 'mock-host', host_ssm: '/mock/host' } }), [
    [['one_of'], '`one_of` matches more than one of its allowed forms'],
  ]);
  assert.deepEqual(messagesOf({ one_of: {}, any_of: {} }).map(([path]) => path), [['one_of'], ['any_of']]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredFieldsToFill } = require('../lib/required-fields');
const { parseConfig } = require('../lib/config');

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: {
    queue: { type: 'object', patternProperties: { '^[a-z_]+$': { $ref: '#/$defs/queue_entry' } } },
  },
  $defs: {
    queue_entry: {
      type: 'object',
      required: ['kms_key_arn', 'size'],
      properties: {
        name: { type: 'string', description: '[required] The mock name.' },
        mode: { enum: ['fast', 'slow'], description: '[required] The mock mode.' },
        kms_key_arn: { type: 'string' },
        settings: { type: 'object', description: '[required] The mock settings.' },
        size: { type: 'integer', description: '[optional] Listed as required, marked optional.' },
        label: { type: 'string', description: '[~required] Required when mode is fast.' },
        tags: { type: 'array', items: { type: 'string' }, description: '[optional] The mock tags.' },
      },
    },
  },
};

function dslWith(keySortOrders, validatorLines = []) {
  const text = [
    'version: "1"',
    'dsls:',
    '  - id: mock',
    '    file_includes: ["**/mock.yml"]',
    '    file_excludes: []',
    '    schema_search_paths: []',
    ...validatorLines,
    `    key_sort_orders: ${JSON.stringify(keySortOrders)}`,
    '    scopes: {}',
    '    declarations: []',
    '    references: []',
  ].join('\n');
  return parseConfig(text, '/repo').dsls[0];
}

const SIGNIFICANCE_NAME_FIRST = [{ path: '$.*.*', skip_keys: [], order: 'significance', first_keys: ['name'], last_keys: [] }];
const noHeldKeys = () => [];

test('Enter after an empty entry key fills the fields marked required or listed in required without a marker', () => {
  const filled = requiredFieldsToFill({
    text: 'queue:\n  alerts:\n    \n',
    keyLine: 1,
    schema,
    dsl: dslWith(SIGNIFICANCE_NAME_FIRST),
    heldKeysAt: noHeldKeys,
  });
  assert.equal(filled.keyColumn, 2);
  assert.deepEqual(filled.fields, [
    { key: 'name', valueKind: 'scalar', values: [], defaultValue: null },
    { key: 'mode', valueKind: 'scalar', values: ['fast', 'slow'], defaultValue: null },
    { key: 'kms_key_arn', valueKind: 'scalar', values: [], defaultValue: null },
    { key: 'settings', valueKind: 'map', values: [], defaultValue: null },
  ]);
});

test('a filled scalar field carries its schema default, followed through a reference', () => {
  const defaultSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      queue: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            dry_run: { type: 'boolean', default: false, description: '[required] Mock dry run.' },
            retention: { $ref: '#/$defs/retention', description: '[required] Mock retention.' },
            tags: { type: 'array', default: ['mock-tag'], description: '[required] Mock tags.' },
          },
        },
      },
    },
    $defs: { retention: { type: 'integer', default: 4 } },
  };
  const filled = requiredFieldsToFill({
    text: 'queue:\n  alerts:\n',
    keyLine: 1,
    schema: defaultSchema,
    dsl: dslWith([]),
    heldKeysAt: noHeldKeys,
  });
  assert.deepEqual(filled.fields.map((field) => [field.key, field.defaultValue]), [
    ['dry_run', 'false'],
    ['retention', '4'],
    ['tags', null],
  ]);
});

test('an alphabetical key sort order sorts the filled fields, and no entry keeps the schema\'s written order', () => {
  const alphabetical = [{ path: '$..*', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] }];
  const fill = (dsl) => requiredFieldsToFill({ text: 'queue:\n  alerts:\n', keyLine: 1, schema, dsl, heldKeysAt: noHeldKeys })
    .fields.map((field) => field.key);
  assert.deepEqual(fill(dslWith(alphabetical)), ['kms_key_arn', 'mode', 'name', 'settings']);
  assert.deepEqual(fill(dslWith([])), ['name', 'mode', 'kms_key_arn', 'settings']);
});

test('a field the common layer already gives the entry is not filled again', () => {
  const filled = requiredFieldsToFill({
    text: 'queue:\n  alerts:\n',
    keyLine: 1,
    schema,
    dsl: dslWith([]),
    heldKeysAt: (mapPath) => (mapPath.join('.') === 'queue.alerts' ? ['name', 'mode'] : []),
  });
  assert.deepEqual(filled.fields.map((field) => field.key), ['kms_key_arn', 'settings']);
});

test('a field the entry\'s key sets by the validator\'s child values from parent key is not filled', () => {
  const settingName = [
    '    validator:',
    '      child_values_from_parent_key:',
    "        - pattern: '^(?<field>[a-z]+) (?<value>[a-z-]+)$'",
  ];
  const anyKeySchema = {
    ...schema,
    properties: { queue: { type: 'object', additionalProperties: { $ref: '#/$defs/queue_entry' } } },
  };
  const filled = requiredFieldsToFill({
    text: 'queue:\n  name mock-alerts:\n',
    keyLine: 1,
    schema: anyKeySchema,
    dsl: dslWith([], settingName),
    heldKeysAt: noHeldKeys,
  });
  assert.deepEqual(filled.fields.map((field) => field.key), ['mode', 'kms_key_arn', 'settings']);
});

test('a key with a value, a map that already holds lines, a scalar field and an unread schema fill nothing', () => {
  const fill = (text, keyLine, fillSchema = schema) => requiredFieldsToFill({
    text,
    keyLine,
    schema: fillSchema,
    dsl: dslWith([]),
    heldKeysAt: noHeldKeys,
  });
  assert.equal(fill('queue:\n  alerts: ref mock.thing\n', 1), null);
  assert.equal(fill('queue:\n  alerts:\n    \n    name: mock\n', 1), null);
  assert.equal(fill('queue:\n  alerts:\n    name:\n', 2), null);
  assert.equal(fill('queue:\n  alerts:\n', 1, { ...schema, $schema: 'https://example.com/mock-draft' }), null);
});

test('Enter after a key whose value is a map with nothing required, or a list, answers the value kind with no fields', () => {
  const fill = (text, keyLine, fillSchema) => requiredFieldsToFill({
    text,
    keyLine,
    schema: fillSchema,
    dsl: dslWith([]),
    heldKeysAt: noHeldKeys,
  });
  const optionalOnly = { properties: { queue: { type: 'object', properties: { alerts: { type: 'object' } } } } };
  assert.deepEqual(fill('queue:\n  alerts:\n', 1, optionalOnly), { keyColumn: 2, valueKind: 'map', fields: [] });
  const listed = { properties: { queue: { type: 'object', properties: { alerts: { type: 'array' } } } } };
  assert.deepEqual(fill('queue:\n  alerts:\n', 1, listed), { keyColumn: 2, valueKind: 'list', fields: [] });
});

test('Enter after an empty key fills the required fields of the branch the document selects', () => {
  const branchedSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      mockthings: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { Type: { enum: ['Mock::Bucket', 'Mock::Queue'] } },
          if: { properties: { Type: { const: 'Mock::Bucket' } }, required: ['Type'] },
          then: {
            properties: {
              Properties: {
                type: 'object',
                required: ['BucketName'],
                properties: { BucketName: { type: 'string' } },
              },
            },
          },
          else: {
            properties: {
              Properties: {
                type: 'object',
                required: ['QueueName'],
                properties: { QueueName: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
  const fillKeysFor = (type) => requiredFieldsToFill({
    text: `mockthings:\n  one:\n    Type: ${type}\n    Properties:\n`,
    keyLine: 3,
    schema: branchedSchema,
    documentValue: { mockthings: { one: { Type: type, Properties: null } } },
    dsl: dslWith([]),
    heldKeysAt: noHeldKeys,
  }).fields.map((field) => field.key);
  assert.deepEqual(fillKeysFor('Mock::Bucket'), ['BucketName']);
  assert.deepEqual(fillKeysFor('Mock::Queue'), ['QueueName']);
});

test('an empty key\'s required fields are read at the path its place maps to, '
  + 'its held keys at the written path', () => {
  const heldAt = [];
  const filled = requiredFieldsToFill({
    text: 'loop:\n  - body:\n      alerts:\n        \n',
    keyLine: 2,
    schema,
    dsl: dslWith(SIGNIFICANCE_NAME_FIRST),
    schemaPathOf: (documentPath) => ['queue', ...documentPath.slice(3)],
    heldKeysAt: (mapPath) => {
      heldAt.push(mapPath);
      return [];
    },
  });
  assert.deepEqual(filled.fields.map((field) => field.key), ['name', 'mode', 'kms_key_arn', 'settings']);
  assert.deepEqual(heldAt, [['loop', 0, 'body', 'alerts']]);
});

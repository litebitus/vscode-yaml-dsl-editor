const test = require('node:test');
const assert = require('node:assert/strict');
const { schemaRendererFor } = require('../lib/json-schema');

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const DRAFT_2019_09 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

function renderedOf(draftUri, node) {
  const root = { $schema: draftUri, $defs: { mock_call_form: { type: 'object' } }, properties: { mock: node } };
  return schemaRendererFor(root).renderNode(root.properties.mock);
}

test('a tuple renders by each draft\'s own keywords, the items in order and the items after them', () => {
  const draft07Tuple = {
    type: 'array',
    items: [{ type: 'string' }, { type: 'integer' }],
    additionalItems: { type: 'boolean' },
  };
  assert.deepEqual(renderedOf(DRAFT_07, draft07Tuple).tags, [
    '*Items:* in order `string`, `integer`',
    '*Further items:* `boolean`',
  ]);
  assert.deepEqual(renderedOf(DRAFT_2019_09, draft07Tuple).tags, [
    '*Items:* in order `string`, `integer`',
    '*Further items:* `boolean`',
  ]);
  const draft2020Tuple = { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer' } };
  assert.deepEqual(renderedOf(DRAFT_2020_12, draft2020Tuple).tags, [
    '*Items:* in order `string`',
    '*Further items:* `integer`',
  ]);
  assert.deepEqual(renderedOf(DRAFT_2020_12, { type: 'array', items: { type: 'integer' } }).tags, ['*Items:* `integer`']);
});

test('keys a key needs render from draft-07 dependencies and the later drafts\' dependentRequired', () => {
  const needs = { mode: ['size', 'kind'], label: { required: ['size'] } };
  assert.deepEqual(renderedOf(DRAFT_07, { type: 'object', dependencies: needs }).tags, [
    '*Dependencies:* `mode` needs `size` and `kind`; `label` needs `size`',
  ]);
  for (const draftUri of [DRAFT_2019_09, DRAFT_2020_12]) {
    assert.deepEqual(renderedOf(draftUri, { type: 'object', dependentRequired: { mode: ['size'] } }).tags, [
      '*Dependencies:* `mode` needs `size`',
    ]);
  }
});

test('a dependent schema renders what its key needs, alternatives included', () => {
  const dependentSchemas = { mode: { anyOf: [{ required: ['size'] }, { $ref: '#/$defs/mock_call_form' }] } };
  for (const draftUri of [DRAFT_2019_09, DRAFT_2020_12]) {
    assert.deepEqual(renderedOf(draftUri, { type: 'object', dependentSchemas }).tags, [
      '*Dependencies:* `mode` needs `size`, or a `mock_call_form`',
    ]);
  }
});

test('a field\'s own dependencies render as what setting it requires, and as what its holder needs', () => {
  const parent = {
    type: 'object',
    dependentRequired: { label: ['kind'] },
    allOf: [{ dependentSchemas: { label: { anyOf: [{ required: ['size'] }, { $ref: '#/$defs/mock_call_form' }] } } }],
  };
  const root = { $schema: DRAFT_2020_12, $defs: { mock_call_form: { type: 'object' } }, properties: { mock: parent } };
  const renderer = schemaRendererFor(root);
  assert.deepEqual(renderer.keyDependencyLinesOf(root.properties.mock, 'label'), [
    '*When set:* `kind` required.',
    '*When set:* `size` required, or a `mock_call_form`.',
  ]);
  assert.equal(
    renderer.dependencyTextOf(root.properties.mock, 'label'),
    '`label` needs `kind`; `size`, or a `mock_call_form`',
  );
  assert.deepEqual(renderer.keyDependencyLinesOf(root.properties.mock, 'size'), []);
  assert.equal(renderer.dependencyTextOf(root.properties.mock, 'size'), null);
});

test('a field is named by the reference it makes, and a node refining a reference by its own shape', () => {
  const root = {
    $schema: DRAFT_2020_12,
    $defs: {
      mock_fields: { patternProperties: { '^mock ': {} } },
      mock_entry: { type: 'object', $ref: '#/$defs/mock_fields', properties: { size: { type: 'integer' } } },
    },
    properties: { entry: { $ref: '#/$defs/mock_entry' }, inline: { $ref: '#/$defs/mock_fields', properties: {} } },
  };
  const renderer = schemaRendererFor(root);
  assert.equal(renderer.renderNode(root.properties.entry).shape, 'mock_entry');
  assert.equal(renderer.renderNode(root.$defs.mock_entry).shape, 'object');
  assert.equal(renderer.renderNode(root.properties.inline).shape, 'any');
});

test('a condition renders its when and otherwise, a condition it cannot read named as stated by the schema', () => {
  const node = {
    type: 'object',
    if: { required: ['count'] },
    then: { anyOf: [{ required: ['size'] }, { $ref: '#/$defs/mock_call_form' }] },
    else: { properties: { size: { minimum: 1 } } },
    allOf: [{ if: { not: { required: ['mode'] } }, then: { required: ['label'] } }],
  };
  assert.deepEqual(renderedOf(DRAFT_2020_12, node).conditions, [
    '*When* `count` is set: `size` required, or a `mock_call_form`.',
    '*Otherwise:* a condition the schema states.',
    '*When* a condition the schema states: `label` required.',
  ]);
});

test('a field\'s share of its parent\'s conditions names what each branch says about it, other alternatives kept whole', () => {
  const parent = {
    type: 'object',
    allOf: [
      {
        if: { properties: { node_type: { const: 'master' } } },
        then: { not: { required: ['count'] } },
        else: { anyOf: [{ required: ['count'] }, { $ref: '#/$defs/mock_call_form' }] },
      },
      { if: { required: ['label'] }, then: { required: ['size'] }, else: { properties: { count: { const: 1 } } } },
      { if: { required: ['mode'] }, then: { required: ['size'] } },
    ],
  };
  const root = { $schema: DRAFT_2020_12, $defs: { mock_call_form: { type: 'object' } }, properties: { mock: parent } };
  const renderer = schemaRendererFor(root);
  assert.deepEqual(renderer.keyConditionLinesOf(root.properties.mock, 'count'), [
    '*When* `node_type` is `"master"`: must not be set.',
    '*Otherwise:* required, or a `mock_call_form`.',
    '*Unless* `label` is set: is `1`.',
  ]);
  assert.deepEqual(renderer.keyConditionLinesOf(root.properties.mock, 'kind'), []);
});

test('an unread draft has no renderer, and a node allowing nothing renders as nothing', () => {
  assert.equal(schemaRendererFor({ $schema: 'https://example.test/mock-draft' }), null);
  assert.equal(renderedOf(DRAFT_2020_12, { anyOf: [false, { type: 'string' }] }).shape, 'nothing | string');
  assert.equal(renderedOf(DRAFT_2020_12, {}).shape, 'any');
});

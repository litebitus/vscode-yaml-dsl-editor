const test = require('node:test');
const assert = require('node:assert/strict');
const { readModeline, parseSchema, fieldDescription } = require('../lib/schema');

const schema = {
  description: 'root',
  properties: {
    redshift: { $ref: '#/definitions/redshift_map', description: '[optional] Redshift clusters.' },
    tags: { additionalProperties: { description: 'tag value' } },
    open: { additionalProperties: true },
    bad: { patternProperties: { '(': { description: 'nope' } }, additionalProperties: false },
    extra: { patternProperties: { '(': { description: 'nope' }, '^x': { description: 'first' } }, additionalProperties: { description: 'fallback field' } },
    list: { items: { description: 'item' } },
    tuple: { items: [{ description: 'no' }] },
  },
  definitions: {
    string_or_ref: { description: 'a literal string, a ref, or a bare local' },
    redshift_map: { patternProperties: { '^(?!defaults$).+$': { $ref: '#/definitions/redshift' } } },
    redshift: { allOf: [{ $ref: '#/definitions/redshift_body' }] },
    redshift_body: {
      properties: {
        database_name: { $ref: '#/definitions/string_or_ref', description: '[optional] Database name.' },
      },
    },
    loop: { $ref: '#/definitions/loop' },
  },
};

test('hover keeps the description beside $ref', () => {
  assert.equal(fieldDescription(schema, ['redshift', 'primary', 'database_name']), '[optional] Database name.');
  assert.equal(fieldDescription(schema, ['redshift']), '[optional] Redshift clusters.');
  assert.equal(fieldDescription(schema, ['redshift', 'primary']), null);
  assert.equal(fieldDescription(schema, []), 'root');
  assert.equal(fieldDescription(schema, ['tags', 'Name']), 'tag value');
  assert.equal(fieldDescription(schema, ['extra', 'x']), 'first');
  assert.equal(fieldDescription(schema, ['extra', 'y']), 'fallback field');
  assert.equal(fieldDescription(schema, ['list', 0]), 'item');
});

test('a missing or unusable schema node has no description', () => {
  assert.equal(fieldDescription(null, []), null);
  assert.equal(fieldDescription([], []), null);
  assert.equal(fieldDescription(schema, ['missing']), null);
  assert.equal(fieldDescription(schema, ['open', 'x']), null);
  assert.equal(fieldDescription(schema, ['bad', 'x']), null);
  assert.equal(fieldDescription(schema, ['tuple', 0]), null);
  assert.equal(fieldDescription(schema, ['list', 'nope']), null);
  assert.equal(fieldDescription({ properties: { a: { $ref: '#/nope', description: 'kept' } } }, ['a', 'b']), null);
  assert.equal(fieldDescription({ properties: { a: { $ref: 'http://example.test/schema', description: 'kept' } } }, ['a']), 'kept');
  const cyclic = { properties: { a: { $ref: '#/definitions/loop', description: 'cycle' } }, definitions: { loop: { $ref: '#/definitions/loop' } } };
  assert.equal(fieldDescription(cyclic, ['a']), 'cycle');
});

test('a modeline is the schema path and only an object schema parses', () => {
  assert.equal(readModeline('# yaml-language-server: $schema=.terraform/modules/resources_yaml/resources.schema.json\n'), '.terraform/modules/resources_yaml/resources.schema.json');
  assert.equal(readModeline('name: a\n'), null);
  assert.deepEqual(parseSchema('{"a":1}'), { a: 1 });
  assert.equal(parseSchema('['), null);
  assert.equal(parseSchema('[]'), null);
  assert.equal(parseSchema('null'), null);
});

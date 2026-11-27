const test = require('node:test');
const assert = require('node:assert/strict');
const { isSchemaUrl, parseSchema, unreadSchemaProblem } = require('../lib/schema');

test('a location naming a scheme is a URL, and a path is not', () => {
  const locations = ['https://example.test/mock.json', 's3://mock-bucket/mock.json', 'mock.schema.json'];
  assert.deepEqual(locations.map(isSchemaUrl), [true, true, false]);
});

test('only an object schema parses, and a schema that does not names why after its name', () => {
  assert.deepEqual(parseSchema('{"a":1}'), { a: 1 });
  assert.equal(parseSchema('['), null);
  assert.equal(parseSchema('[]'), null);
  assert.equal(parseSchema('null'), null);
  assert.match(unreadSchemaProblem('mock.schema.json', '['), /^schema mock\.schema\.json: .+/);
  assert.equal(unreadSchemaProblem('mock.schema.json', '[]'), 'schema mock.schema.json: not a JSON object');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { readModeline, parseSchema } = require('../lib/schema');

test('a modeline is the schema path and only an object schema parses', () => {
  assert.equal(readModeline('# yaml-language-server: $schema=.schema/sample.schema.json\n'), '.schema/sample.schema.json');
  assert.equal(readModeline('name: a\n'), null);
  assert.deepEqual(parseSchema('{"a":1}'), { a: 1 });
  assert.equal(parseSchema('['), null);
  assert.equal(parseSchema('[]'), null);
  assert.equal(parseSchema('null'), null);
});

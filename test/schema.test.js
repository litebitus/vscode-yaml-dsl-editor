const test = require('node:test');
const assert = require('node:assert/strict');
const { readModeline, modelineSchemaSpanOf, isSchemaUrl, parseSchema } = require('../lib/schema');

test('the modeline\'s schema path spans the text after $schema=, on whatever line the modeline is', () => {
  const text = 'name: a\n# yaml-language-server: $schema=../mock.schema.json\n';
  const span = modelineSchemaSpanOf(text);
  assert.deepEqual([span.spec, text.slice(span.start, span.end)], ['../mock.schema.json', '../mock.schema.json']);
  assert.equal(modelineSchemaSpanOf('name: a\n'), null);
  assert.deepEqual([isSchemaUrl('https://example.test/mock.json'), isSchemaUrl('mock.schema.json')], [true, false]);
});

test('a modeline is the schema path and only an object schema parses', () => {
  assert.equal(readModeline('# yaml-language-server: $schema=.schema/sample.schema.json\n'), '.schema/sample.schema.json');
  assert.equal(readModeline('name: a\n'), null);
  assert.deepEqual(parseSchema('{"a":1}'), { a: 1 });
  assert.equal(parseSchema('['), null);
  assert.equal(parseSchema('[]'), null);
  assert.equal(parseSchema('null'), null);
});

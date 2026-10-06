const test = require('node:test');
const assert = require('node:assert/strict');
const { valueStarts } = require('../lib/value-starts');

test('a value starts after a key, after a list marker, and at each flow item', () => {
  assert.deepEqual(valueStarts('  vpc_id: ref a.b'), [10]);
  assert.deepEqual(valueStarts('  - ref a.b'), [4]);
  assert.deepEqual(valueStarts('  - name: x'), [10]);
  assert.deepEqual(valueStarts('  key:'), [6]);
  assert.deepEqual(valueStarts('  typing_a_key'), []);
  assert.deepEqual(valueStarts('  list: [ref a.b, ref c.d]'), [8, 9, 18]);
});

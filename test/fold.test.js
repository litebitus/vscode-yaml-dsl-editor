const test = require('node:test');
const assert = require('node:assert/strict');
const { foldDocument } = require('../lib/fold');

test('a fold is the common layer under the overlay', () => {
  const present = foldDocument('one', { mocktype: { primary: { name: 'a', old: 1 } } }, { mocktype: { primary: { old: null, name: 'b' } } }, true);
  assert.equal(present.value.mocktype.primary.name, 'b');
  assert.equal(present.value.mocktype.primary.old, undefined);
  assert.match(present.text, /^# one — common layer merged with the one overlay/);
  const missing = foldDocument('two', { mocktype: { primary: { name: 'a' } } }, null, false);
  assert.equal(missing.value.mocktype.primary.name, 'a');
  assert.match(missing.text, /the common layer/);
  const empty = foldDocument('three', { mocktype: { primary: { name: 'a' } } }, { mocktype: { primary: {} } }, true);
  assert.equal(empty.value.mocktype.primary.name, 'a');
  const blank = foldDocument('one', null, null, true);
  assert.deepEqual(blank.value, {});
});

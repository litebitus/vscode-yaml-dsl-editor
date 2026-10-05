const test = require('node:test');
const assert = require('node:assert/strict');
const { contains, indexToPos, rangeBetween, zeroRange } = require('../lib/range');

test('contains respects line and character bounds', () => {
  const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  assert.equal(contains(null, { line: 0, character: 0 }), false);
  assert.equal(contains(range, null), false);
  assert.equal(contains(range, { line: 0, character: 3 }), false);
  assert.equal(contains(range, { line: 2, character: 3 }), false);
  assert.equal(contains(range, { line: 1, character: 1 }), false);
  assert.equal(contains(range, { line: 1, character: 5 }), false);
  assert.equal(contains(range, { line: 1, character: 2 }), true);
  assert.equal(contains(range, { line: 1, character: 4 }), true);
});

test('index conversion clamps and counts newlines', () => {
  const text = 'ab\ncd';
  assert.deepEqual(indexToPos(text, -3), { line: 0, character: 0 });
  assert.deepEqual(indexToPos(text, 99), { line: 1, character: 2 });
  assert.deepEqual(indexToPos(text, 3), { line: 1, character: 0 });
  assert.deepEqual(rangeBetween(text, 0, 2).end, { line: 0, character: 2 });
  assert.deepEqual(zeroRange().start, { line: 0, character: 0 });
});

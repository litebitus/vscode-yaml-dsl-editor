const test = require('node:test');
const assert = require('node:assert/strict');
const { deepMerge } = require('../lib/merge');

test('overlay wins, null deletes, and nested maps merge', () => {
  const base = { a: 1, keep: { x: 1, y: 2 }, list: [1] };
  const merged = deepMerge(base, { a: 2, keep: { y: 3, z: 4 }, list: [9], extra: { n: 1 } });
  assert.deepEqual(merged, { a: 2, keep: { x: 1, y: 3, z: 4 }, list: [9], extra: { n: 1 } });
  assert.deepEqual(base.keep, { x: 1, y: 2 });
});

test('null deletes a key and an empty map deletes only above depth zero', () => {
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { a: null }), { b: 2 });
  assert.deepEqual(deepMerge({ a: 1 }, { missing: null }), { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: {} }, 0), { a: { b: 1 } });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: {} }, 1), {});
  assert.deepEqual(deepMerge({ a: { b: { c: 1 } } }, { a: { b: {} } }, 1), { a: { b: { c: 1 } } });
});

test('a non-object base or overlay does not merge', () => {
  assert.deepEqual(deepMerge(null, { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, [1]), { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: [1, { c: 2 }] } }, { a: { b: [3] } }).a.b, [3]);
});

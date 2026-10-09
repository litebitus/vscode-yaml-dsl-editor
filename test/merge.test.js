const test = require('node:test');
const assert = require('node:assert/strict');
const { deepMerge, keepsBaseAt } = require('../lib/merge');

const BASE_MARKER = 'mock-base-value';

function baseHolding(path) {
  let holder = BASE_MARKER;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const step = path[index];
    holder = typeof step === 'number' ? Object.assign([], { [step]: holder }) : { [step]: holder };
  }
  return holder;
}

function nodeAt(value, path) {
  let node = value;
  for (const step of path) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, step)) {
      return { held: false };
    }
    node = node[step];
  }
  return { held: true, node };
}

function mergeKeepsBase(overlay, path, inKey) {
  const found = nodeAt(deepMerge(baseHolding(path), overlay), path);
  return inKey ? found.held : found.held && found.node === BASE_MARKER;
}

const MERGE_CASES = [
  { overlay: null, path: ['a', 'b'] },
  { overlay: [1], path: ['a', 'b'] },
  { overlay: {}, path: ['a', 'b'] },
  { overlay: { other: 1 }, path: ['a', 'b'] },
  { overlay: { a: { other: 1 } }, path: ['a', 'b'] },
  { overlay: { a: { b: 'mock-own-value' } }, path: ['a', 'b'] },
  { overlay: { a: { b: { c: 1 } } }, path: ['a', 'b'] },
  { overlay: { a: { b: null } }, path: ['a', 'b'] },
  { overlay: { a: { b: {} } }, path: ['a', 'b'] },
  { overlay: { a: {} }, path: ['a', 'b'] },
  { overlay: { a: null }, path: ['a', 'b'] },
  { overlay: { a: 'mock-own-value' }, path: ['a', 'b'] },
  { overlay: { a: ['mock-own-value'] }, path: ['a', 'b'] },
  { overlay: { a: { list: ['mock-own-value'] } }, path: ['a', 'list', 0] },
  { overlay: { a: { list: { 0: 'mock-own-value' } } }, path: ['a', 'list', 0] },
  { overlay: { a: { list: ['mock-own-value'] } }, path: ['a', 'list', 0, 'b'] },
  { overlay: { a: { other: 1 } }, path: ['a', 'list', 0] },
  { overlay: { a: { b: { c: 1 } } }, path: ['a', 'b', 'c'] },
  { overlay: { a: { b: { other: 1 } } }, path: ['a', 'b', 'c'] },
];

test('keepsBaseAt answers whether the merge keeps the base value at a path', () => {
  for (const { overlay, path } of MERGE_CASES) {
    const expected = mergeKeepsBase(overlay, path, false);
    assert.equal(keepsBaseAt(overlay, path, false), expected, JSON.stringify({ overlay, path }));
  }
});

test('keepsBaseAt answers whether the merge keeps the base key at a path ending in a key', () => {
  for (const { overlay, path } of MERGE_CASES.filter((item) => typeof item.path.at(-1) === 'string')) {
    const expected = mergeKeepsBase(overlay, path, true);
    assert.equal(keepsBaseAt(overlay, path, true), expected, JSON.stringify({ overlay, path }));
  }
});

test('keepsBaseAt holds the base at the root path', () => {
  assert.equal(keepsBaseAt({ a: 1 }, [], false), true);
});

test('overlay wins, null deletes, and nested maps merge', () => {
  const base = { a: 1, keep: { x: 1, y: 2 }, list: [1] };
  const merged = deepMerge(base, { a: 2, keep: { y: 3, z: 4 }, list: [9], extra: { n: 1 } });
  assert.deepEqual(merged, { a: 2, keep: { x: 1, y: 3, z: 4 }, list: [9], extra: { n: 1 } });
  assert.deepEqual(base.keep, { x: 1, y: 2 });
});

test('null deletes a key and an empty map replaces it at any depth', () => {
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { a: null }), { b: 2 });
  assert.deepEqual(deepMerge({ a: 1 }, { missing: null }), { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: {} }), { a: {} });
  assert.deepEqual(deepMerge({ a: { b: { c: 1 } } }, { a: { b: {} } }), { a: { b: {} } });
  assert.deepEqual(deepMerge({ a: 1 }, { b: {} }), { a: 1, b: {} });
});

test('a non-object base or overlay does not merge', () => {
  assert.deepEqual(deepMerge(null, { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, [1]), { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: [1, { c: 2 }] } }, { a: { b: [3] } }).a.b, [3]);
});

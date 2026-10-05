const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache, STACK_CAPACITY } = require('../lib/cache');

test('the ninth unpinned stack evicts the least recently used', () => {
  const cache = createCache();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) cache.hold(id, { id });
  cache.touch('a');
  cache.hold('i', { id: 'i' });
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('a'));
  assert.ok(cache.get('i'));
  assert.deepEqual(cache.takeEvicted(), ['b']);
  assert.equal(STACK_CAPACITY, 8);
  assert.ok(cache.ids().includes('i'));
});

test('pinned and on-screen stacks stay, and a repeat hold updates in place', () => {
  const cache = createCache();
  cache.hold('p', { n: 1 }, { pinned: true });
  cache.hold('s', { n: 1 }, { onScreen: true });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) cache.hold(id, { id });
  cache.hold('i', { id: 'i' });
  assert.ok(cache.get('p'));
  assert.ok(cache.get('s'));
  assert.equal(cache.get('a'), null);
  cache.hold('p', { n: 2 });
  assert.equal(cache.get('p').data.n, 2);
  assert.equal(cache.get('p').pinned, true);
  cache.setFlags('missing', { pinned: false, onScreen: false });
  cache.setFlags('p', { pinned: false, onScreen: false });
  cache.rebalance();
  assert.equal(cache.touch('missing'), null);
  assert.ok(cache.takeEvicted().includes('b') || cache.get('p'));
});

test('identical schema bytes share one copy and eviction does not drop it', () => {
  const cache = createCache();
  const first = cache.noteSchema('{"a":1}', { a: 1 });
  const second = cache.noteSchema('{"a":1}', { a: 1 });
  const third = cache.noteSchema('{"a":2}', { a: 2 });
  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.equal(cache.schemaCount(), 2);
  assert.deepEqual(cache.schemaObject(first), { a: 1 });
  assert.equal(cache.schemaObject('missing'), null);
  for (let i = 0; i < 9; i += 1) cache.hold(`s${i}`, {});
  assert.equal(cache.schemaCount(), 2);
});

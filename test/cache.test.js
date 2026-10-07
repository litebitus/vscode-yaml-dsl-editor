const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache, DEFAULT_CACHE_CAPACITIES } = require('../lib/cache');

function cacheHolding(stackCapacity, schemaCapacity = 32) {
  const cache = createCache();
  cache.setCapacities({ stackCapacity, schemaCapacity });
  return cache;
}

test('a stack past the capacity evicts the least recently used', () => {
  const cache = cacheHolding(8);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) cache.hold(id, { id });
  cache.touch('a');
  cache.hold('i', { id: 'i' });
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('a'));
  assert.ok(cache.get('i'));
  assert.deepEqual(cache.takeEvicted(), ['b']);
  assert.deepEqual(DEFAULT_CACHE_CAPACITIES, { stackCapacity: 32, schemaCapacity: 32 });
  assert.ok(cache.ids().includes('i'));
});

test('lowering the stack capacity evicts at once, and a capacity that is not a whole number above 0 is refused', () => {
  const cache = createCache();
  for (const id of ['a', 'b', 'c']) cache.hold(id, { id });
  cache.setCapacities({ stackCapacity: 1, schemaCapacity: 32 });
  assert.deepEqual(cache.takeEvicted(), ['a', 'b']);
  assert.throws(() => cache.setCapacities({ stackCapacity: 0, schemaCapacity: 32 }), /stackCapacity must be a whole number/);
  assert.throws(() => cache.setCapacities({ stackCapacity: 2 }), /schemaCapacity must be a whole number/);
  assert.ok(cache.get('c'));
});

test('pinned and on-screen stacks stay, and a repeat hold updates in place', () => {
  const cache = cacheHolding(8);
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

test('identical schema bytes share one copy', () => {
  const cache = createCache();
  const parsed = [];
  const parse = (text) => {
    parsed.push(text);
    return JSON.parse(text);
  };
  const first = cache.noteSchema('{"a":1}', parse);
  const second = cache.noteSchema('{"a":1}', parse);
  const third = cache.noteSchema('{"a":2}', parse);
  assert.deepEqual(parsed, ['{"a":1}', '{"a":2}']);
  assert.equal(cache.noteSchema('[', () => null), null);
  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.equal(cache.schemaCount(), 2);
  assert.deepEqual(cache.schemaObject(first), { a: 1 });
  assert.equal(cache.schemaObject('missing'), null);
});

test('schemas a stack uses stay, and past the capacity the least recently used of the rest go', () => {
  const cache = cacheHolding(8, 1);
  const schemaHash = (n) => cache.noteSchema(`{"n":${n}}`, JSON.parse);
  const used = schemaHash(1);
  cache.hold('uses-one', { schemas: new Map([['/mock/a.yml', { hash: used }]]) });
  const older = schemaHash(2);
  const newer = schemaHash(3);
  cache.rebalance();
  cache.schemaObject(older);
  cache.rebalance();
  assert.ok(cache.schemaObject(used));
  assert.ok(cache.schemaObject(older));
  assert.equal(cache.schemaObject(newer), null);
  cache.drop('uses-one');
  cache.rebalance();
  assert.equal(cache.schemaObject(used), null);
  assert.equal(cache.schemaCount(), 1);
});

test('a schema just noted survives one eviction pass, so the stack being built can hold it', () => {
  const cache = cacheHolding(8, 1);
  const first = cache.noteSchema('{"n":1}', JSON.parse);
  const second = cache.noteSchema('{"n":2}', JSON.parse);
  cache.hold('held-meanwhile', {});
  cache.hold('builds-both', { schemas: new Map([['/mock/a.yml', { hash: first }], ['/mock/b.yml', { hash: second }]]) });
  assert.ok(cache.schemaObject(first));
  assert.ok(cache.schemaObject(second));
});

test('a held or replaced stack is reported reanalyzed once, and an evicted one is not', () => {
  const cache = cacheHolding(8);
  cache.hold('a', { n: 1 });
  cache.hold('b', { n: 1 });
  assert.deepEqual(cache.takeReanalyzed(), ['a', 'b']);
  assert.deepEqual(cache.takeReanalyzed(), []);
  cache.replaceData('a', { n: 2 });
  assert.equal(cache.replaceData('missing', {}), null);
  assert.deepEqual(cache.takeReanalyzed(), ['a']);
  for (const id of ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']) cache.hold(id, {});
  assert.equal(cache.takeReanalyzed().includes('a'), false);
});

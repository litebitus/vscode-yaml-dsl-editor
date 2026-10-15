const test = require('node:test');
const assert = require('node:assert/strict');
const { sortedKeys, significanceRankOf } = require('../lib/key-sort-orders');

const significance = { order: 'significance', firstKeys: ['name'], lastKeys: ['outputs'] };

test('significance puts the first keys first and the last keys last, keeping every other key in its written order', () => {
  assert.deepEqual(sortedKeys(['size', 'outputs', 'mode', 'name'], significance), ['name', 'size', 'mode', 'outputs']);
  assert.deepEqual([significanceRankOf('name', significance), significanceRankOf('outputs', significance)], [0, 2]);
});

test('alphabetical sorts every key, and no sort order keeps the written order', () => {
  assert.deepEqual(sortedKeys(['size', 'mode'], { order: 'alphabetical', firstKeys: [], lastKeys: [] }), ['mode', 'size']);
  assert.deepEqual(sortedKeys(['size', 'mode'], null), ['size', 'mode']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml } = require('../lib/tree');
const { createNodeIds } = require('../lib/node-ids');

function rootOf(text, nodeIds) {
  return parseYaml(text, nodeIds).tree;
}

test('equal values share an id whatever their comments, quoting, style and key order', () => {
  const nodeIds = createNodeIds();
  const block = rootOf('mock:\n  a: 1   # one\n  b: "x"\n  c: [1, 2]\n', nodeIds);
  const flow = rootOf("mock: { c: [1, 2], b: 'x', a: 1 }\n", nodeIds);
  assert.equal(block.id, flow.id);
  assert.equal(block.entries[0].value.id, flow.entries[0].value.id);
  assert.notEqual(rootOf('mock: { a: "1", b: x, c: [1, 2] }\n', nodeIds).id, block.id);
  assert.notEqual(rootOf('mock: { a: 1, b: x, c: [2, 1] }\n', nodeIds).id, block.id);
});

test('a shape id counts every scalar alike, so the same keys at every depth share it', () => {
  const nodeIds = createNodeIds();
  const dev = rootOf('mock:\n  retention: 86400\n  tags: [a]\n', nodeIds);
  const production = rootOf('mock:\n  retention: 1209600\n  tags: [b]\n', nodeIds);
  assert.notEqual(dev.id, production.id);
  assert.equal(dev.shapeId, production.shapeId);
  assert.notEqual(rootOf('mock:\n  retention: 1\n', nodeIds).shapeId, dev.shapeId);
  assert.notEqual(rootOf('mock:\n  retention: 1\n  tags: [a, b]\n', nodeIds).shapeId, dev.shapeId);
});

test('an empty value is the null scalar, and an unchanged block keeps its id across parses', () => {
  const nodeIds = createNodeIds();
  const empty = rootOf('mock:\n  a:\n', nodeIds);
  const nulled = rootOf('mock:\n  a: null\n', nodeIds);
  assert.equal(empty.id, nulled.id);
  const first = rootOf('kept:\n  a: 1\nedited: 1\n', nodeIds);
  const sizeBefore = nodeIds.size();
  const second = rootOf('kept:\n  a: 1\nedited: 2\n', nodeIds);
  assert.equal(first.entries[0].value.id, second.entries[0].value.id);
  assert.ok(nodeIds.size() > sizeBefore);
  assert.equal(parseYaml('a: 1\nb: [1]\n').nodeCount, 4);
});

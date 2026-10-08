const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml } = require('../lib/tree');

test('a document becomes a tree of maps, sequences, and scalars', () => {
  const parsed = parseYaml('name: primary\nitems:\n  - 1\n  - two\n');
  assert.equal(parsed.tree.kind, 'map');
  assert.equal(parsed.tree.entries[0].key, 'name');
  assert.equal(parsed.tree.entries[0].value.value, 'primary');
  assert.equal(parsed.tree.entries[1].value.kind, 'seq');
  assert.equal(parsed.tree.entries[1].value.items[0].value, 1);
  assert.equal(parsed.value.items[1], 'two');
  assert.deepEqual(parsed.errors, []);
});

test('aliases resolve and a broken document reports an error', () => {
  const alias = parseYaml('a: &id 1\nb: *id\n');
  assert.equal(alias.tree.entries[1].value.value, 1);
  const cycle = parseYaml('a: &a\n  self: *a\n');
  assert.equal(cycle.tree.entries[0].value.entries[0].value, null);
  const broken = parseYaml('a: [\n');
  assert.ok(broken.errors.length > 0);
  const unclosed = parseYaml('# c\nlocals:\n  db: x\nlist: [one, two\n');
  assert.deepEqual(unclosed.errors.map((error) => error.range), [
    { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } },
  ]);
  const midway = parseYaml('a: 1\nb: c: d\ne: 2\n');
  assert.deepEqual(midway.errors[0].range.start.line, 1);
  assert.equal(parseYaml('').tree, null);
  assert.equal(parseYaml('').value, null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml, keyRangeAt } = require('../lib/tree');

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

test('a key typed without its colon is an unfinished key on its own line, wherever it stands in its map', () => {
  const keyOn = (text) => {
    const parsed = parseYaml(text);
    return { errors: parsed.errors, unfinishedKeys: parsed.unfinishedKeys };
  };
  const middle = { key: 'sc', range: { start: { line: 2, character: 2 }, end: { line: 2, character: 4 } } };
  assert.deepEqual(keyOn('a:\n  b: 1\n  sc\n  c: 2\n'), { errors: [], unfinishedKeys: [middle] });
  assert.deepEqual(keyOn('a:\n  b: 1\n  sc\nd: 3\n'), { errors: [], unfinishedKeys: [middle] });
  assert.deepEqual(keyOn('a:\n  b: 1\n  sc'), { errors: [], unfinishedKeys: [middle] });
  const top = { key: 'sc', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } };
  assert.deepEqual(keyOn('sc\na: 1\n'), { errors: [], unfinishedKeys: [top] });
  const item = { key: 'sc', range: { start: { line: 2, character: 4 }, end: { line: 2, character: 6 } } };
  assert.deepEqual(keyOn('a:\n  - x: 1\n    sc\n'), { errors: [], unfinishedKeys: [item] });
  assert.deepEqual(parseYaml('a:\n  - sc\n  - b\n').unfinishedKeys, []);
  assert.deepEqual(parseYaml('a: 1\nb: c: d\n').unfinishedKeys, []);
});

test('a key a map holds twice is a duplicate on each copy, naming the lines of the others', () => {
  const parsed = parseYaml('a:\n  b: 1\n  c: 2\n  b: 3\n  b: 4\nb: 5\n');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.duplicateKeys, [
    { key: 'b', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, otherLines: [3, 4] },
    { key: 'b', range: { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } }, otherLines: [1, 4] },
    { key: 'b', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } }, otherLines: [1, 3] },
  ]);
  assert.deepEqual(parseYaml('- a: 1\n  a: 2\n').duplicateKeys.map((duplicate) => duplicate.otherLines), [[1], [0]]);
});

test('the lines around an unfinished key parse as if it were not there', () => {
  const parsed = parseYaml('a:\n  sc\n  de\n  b: 1\n');
  assert.deepEqual(parsed.unfinishedKeys.map((unfinishedKey) => unfinishedKey.key), ['sc', 'de']);
  assert.deepEqual(parsed.value, { a: { b: 1 } });
  assert.deepEqual(parsed.tree.entries[0].value.entries[0].keyRange.start, { line: 3, character: 2 });
});

test('the key range at a path is the last key of that name, or an item\'s range, and nothing for a path not held', () => {
  const { tree } = parseYaml('a:\n  b: 1\n  b: 2\n  list:\n    - x\n    -\n');
  assert.deepEqual(keyRangeAt(tree, ['a', 'b']), { start: { line: 2, character: 2 }, end: { line: 2, character: 3 } });
  assert.deepEqual(keyRangeAt(tree, ['a', 'list', 0]).start, { line: 4, character: 6 });
  assert.deepEqual(keyRangeAt(tree, ['a', 'list', 1]).start, { line: 5, character: 5 });
  assert.equal(keyRangeAt(tree, ['a', 'list', 2]), null);
  assert.equal(keyRangeAt(tree, ['a', 'missing']), null);
  assert.equal(keyRangeAt(tree, ['a', 'b', 'deeper']), null);
  assert.equal(keyRangeAt(tree, []), null);
});

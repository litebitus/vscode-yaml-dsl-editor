const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml } = require('../lib/tree');
const {
  deletionOf,
  insertionUnder,
  localsInsertion,
  placementIn,
  blockLines,
  normalizedEdits,
  applyEdits,
} = require('../lib/common-layer-edits');

function docOf(text) {
  return { text, tree: parseYaml(text).tree, filePath: '/repo/mock.yml' };
}

const optOut = (indent) => [`${' '.repeat(indent)}events: {}`];
const alphabetical = (parentMap, parentPath, newKey) => placementIn(parentMap, newKey, 'alphabetical', []);
const unordered = () => null;

function mapOf(keys) {
  return { entries: keys.map((key) => ({ key })) };
}

test('alphabetical places a key in the sorted run at the top of the map, never past where the order breaks', () => {
  const broken = mapOf(['alpha', 'delta', 'zulu', 'bravo', 'echo']);
  assert.equal(placementIn(broken, 'charlie', 'alphabetical', []).before.key, 'delta');
  assert.equal(placementIn(broken, 'zz', 'alphabetical', []).after.key, 'zulu');
  assert.equal(placementIn(mapOf(['name', 'execution_role_arn']), 'log_types', 'alphabetical', []).before.key, 'name');
  assert.equal(placementIn(mapOf(['a', 'b']), 'c', 'alphabetical', []).after.key, 'b');
  assert.equal(placementIn(mapOf(['b', null, 'a']), 'c', 'alphabetical', []).after.key, 'b');
});

test('significance places a key where the overlays holding it place it, the first one that shares a neighbor', () => {
  const common = mapOf(['kms_key', 'data_source', 'outputs']);
  const source = ['kms_key', 'queue', 'data_source', 'outputs'];
  assert.equal(placementIn(common, 'queue', 'significance', [source]).before.key, 'data_source');
  assert.equal(placementIn(mapOf(['kms_key']), 'queue', 'significance', [source]).after.key, 'kms_key');
  const holderOrders = [['queue'], ['locals', 'queue']];
  assert.equal(placementIn(mapOf(['locals']), 'queue', 'significance', holderOrders).after.key, 'locals');
  assert.equal(placementIn(mapOf(['other']), 'queue', 'significance', [source]).before.key, 'other');
  assert.equal(placementIn(mapOf(['other']), 'locals', 'significance', [source]).before.key, 'other');
});

test('an insertion under a path writes the missing keys at the file\'s own indentation, in the map\'s order', () => {
  const nested = docOf('queue:\n    other: 1\n');
  const edit = insertionUnder(nested, ['queue', 'deep', 'events'], ['queue', 'deep', 'events'], optOut, alphabetical);
  assert.equal(applyEdits(nested.text, [edit]), 'queue:\n    deep:\n        events: {}\n    other: 1\n');
  const unterminated = docOf('a: 1');
  const appended = insertionUnder(unterminated, ['events'], ['events'], optOut, alphabetical);
  assert.equal(applyEdits(unterminated.text, [appended]), 'a: 1\nevents: {}\n');
  const blank = docOf('');
  assert.equal(applyEdits('', [insertionUnder(blank, ['events'], ['events'], optOut, alphabetical)]), 'events: {}\n');
  const refused = (text, keys) => insertionUnder(docOf(text), keys, keys, optOut, alphabetical);
  assert.equal(refused('queue: {other: 1}\n', ['queue', 'events']), null);
  assert.equal(refused('queue: 1\n', ['queue', 'events']), null);
  assert.equal(refused('queue:\n  events: 1\n', ['queue', 'events']), null);
  assert.equal(refused('- item\n', ['events']), null);
  assert.equal(insertionUnder(docOf('a: 1\n'), ['events'], ['events'], () => null, alphabetical), null);
  assert.equal(insertionUnder(docOf('a: 1\n'), ['events'], ['events'], optOut, unordered), null);
});

test('a deletion takes the entry\'s lines and a parent it leaves empty, merging the blank lines around it', () => {
  const text = 'keep: 1\nqueue:\n  events:\n    a: 1   # note\n';
  assert.equal(applyEdits(text, [deletionOf(docOf(text), ['queue', 'events'])]), 'keep: 1\n');
  const sibling = 'queue:\n  events:\n    a: 1\n  other: 2\n';
  assert.equal(applyEdits(sibling, [deletionOf(docOf(sibling), ['queue', 'events'])]), 'queue:\n  other: 2\n');
  const spaced = 'keep: 1\n\nqueue:\n  a: 1\n\nnext: 2\n';
  assert.equal(applyEdits(spaced, [deletionOf(docOf(spaced), ['queue'])]), 'keep: 1\n\nnext: 2\n');
  const leading = 'queue:\n  a: 1\n\nnext: 2\n';
  assert.equal(applyEdits(leading, [deletionOf(docOf(leading), ['queue'])]), 'next: 2\n');
  const tight = 'keep: 1\nqueue:\n  a: 1\n\nnext: 2\n';
  assert.equal(applyEdits(tight, [deletionOf(docOf(tight), ['queue'])]), 'keep: 1\n\nnext: 2\n');
  const trailing = 'keep: 1\n\nqueue:\n  a: 1\n\n';
  assert.equal(applyEdits(trailing, [deletionOf(docOf(trailing), ['queue'])]), 'keep: 1\n');
  assert.equal(deletionOf(docOf('queue:\n  other: 1\n'), ['queue', 'events']), null);
});

test('locals join the existing locals map in its order, or open one', () => {
  const declared = [{ name: 'zeta', valueText: '2' }, { name: 'mock_size', valueText: '1' }];
  const existing = docOf('locals:\n  alpha: x\n  team: mock\nqueue: {}\n');
  assert.equal(applyEdits(existing.text, localsInsertion(existing, ['locals'], ['locals'], declared, alphabetical)),
    'locals:\n  alpha: x\n  mock_size: 1\n  team: mock\n  zeta: 2\nqueue: {}\n');
  const missing = docOf('queue: {}\n');
  assert.equal(applyEdits(missing.text, localsInsertion(missing, ['locals'], ['locals'], declared, alphabetical)),
    'locals:\n  mock_size: 1\n  zeta: 2\nqueue: {}\n');
  assert.deepEqual(localsInsertion(missing, ['locals'], ['locals'], [], alphabetical), []);
  assert.equal(localsInsertion(docOf('locals: {}\n'), ['locals'], ['locals'], declared, alphabetical), null);
  assert.equal(localsInsertion(docOf('- item\n'), ['locals'], ['locals'], declared, alphabetical), null);
  assert.equal(localsInsertion(existing, ['locals'], ['locals'], declared, unordered), null);
  assert.equal(localsInsertion(missing, ['locals'], ['locals'], declared, unordered), null);
});

test('a copied block keeps its own indentation below the new key and its replacements', () => {
  const source = docOf('queue:\n    events:\n        size: 1\n\n        name: x\n');
  const entry = source.tree.entries[0].value.entries[0];
  const size = entry.value.entries[0].value;
  const lines = blockLines(source, entry, [{ start: size.start, end: size.end, text: 'local.size' }], 2);
  assert.deepEqual(lines, ['  events:', '      size: local.size', '', '      name: x']);
  const ragged = docOf('queue:\n  events: |\n    one\n');
  const block = ragged.tree.entries[0].value.entries[0];
  assert.deepEqual(blockLines(ragged, block, [], 0), ['events: |', '  one']);
  const outdented = docOf('queue:\n  events:\n    a: 1\n# note\n    b: 2\n');
  assert.equal(blockLines(outdented, outdented.tree.entries[0].value.entries[0], [], 0), null);
});

test('edits on one file merge where they touch and refuse to overlap', () => {
  assert.deepEqual(normalizedEdits([
    { start: 4, end: 8, text: '' },
    { start: 4, end: 4, text: 'a' },
    { start: 8, end: 8, text: 'b' },
    { start: 8, end: 8, text: 'c' },
  ]), [{ start: 4, end: 8, text: 'abc' }]);
  assert.equal(normalizedEdits([{ start: 0, end: 5, text: '' }, { start: 3, end: 6, text: '' }]), null);
  assert.deepEqual(normalizedEdits([{ start: 6, end: 9, text: '' }, { start: 0, end: 5, text: '' }]), [
    { start: 0, end: 5, text: '' },
    { start: 6, end: 9, text: '' },
  ]);
});

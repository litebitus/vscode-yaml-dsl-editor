const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml } = require('../lib/tree');
const {
  deletionOf,
  insertionUnder,
  localsInsertion,
  placementIn,
  sourceSpacingOf,
  NO_BLANK_LINES,
  blockLines,
  normalizedEdits,
  applyEdits,
} = require('../lib/common-layer-edits');

function docOf(text) {
  return { text, tree: parseYaml(text).tree, filePath: '/repo/mock.yml' };
}

const optOut = (indent) => [`${' '.repeat(indent)}events: {}`];
const ALPHABETICAL = { order: 'alphabetical', firstKeys: [], lastKeys: [] };
const SIGNIFICANCE = { order: 'significance', firstKeys: [], lastKeys: [] };
const RESOURCE_SIGNIFICANCE = {
  order: 'significance',
  firstKeys: ['schema_version', 'env', 'locals'],
  lastKeys: ['data_source', 'outputs'],
};
const alphabetical = (parentMap, parentPath, newKey) => ({
  ...placementIn(parentMap, newKey, ALPHABETICAL, []),
  spacing: NO_BLANK_LINES,
});
const unordered = () => null;

function mapOf(keys) {
  return { entries: keys.map((key) => ({ key })) };
}

test('alphabetical places a key in the sorted run at the top of the map, never past where the order breaks', () => {
  const broken = mapOf(['alpha', 'delta', 'zulu', 'bravo', 'echo']);
  assert.equal(placementIn(broken, 'charlie', ALPHABETICAL, []).before.key, 'delta');
  assert.equal(placementIn(broken, 'zz', ALPHABETICAL, []).after.key, 'zulu');
  assert.equal(placementIn(mapOf(['name', 'execution_role_arn']), 'log_types', ALPHABETICAL, []).before.key, 'name');
  assert.equal(placementIn(mapOf(['a', 'b']), 'c', ALPHABETICAL, []).after.key, 'b');
  assert.equal(placementIn(mapOf(['b', null, 'a']), 'c', ALPHABETICAL, []).after.key, 'b');
});

test('significance places a key where the overlays holding it place it, the first one that shares a neighbor', () => {
  const common = mapOf(['kms_key', 'data_source', 'outputs']);
  const source = ['kms_key', 'queue', 'data_source', 'outputs'];
  assert.equal(placementIn(common, 'queue', SIGNIFICANCE, [source]).before.key, 'data_source');
  assert.equal(placementIn(mapOf(['kms_key']), 'queue', SIGNIFICANCE, [source]).after.key, 'kms_key');
  const holderOrders = [['queue'], ['locals', 'queue']];
  assert.equal(placementIn(mapOf(['locals']), 'queue', SIGNIFICANCE, holderOrders).after.key, 'locals');
  assert.equal(placementIn(mapOf(['other']), 'queue', SIGNIFICANCE, [source]).after.key, 'other');
});

test('significance keeps first_keys at the top and last_keys at the bottom, other keys between them', () => {
  const common = mapOf(['schema_version', 'locals', 'airflow', 'data_source']);
  assert.equal(placementIn(common, 'env', RESOURCE_SIGNIFICANCE, []).before.key, 'locals');
  assert.equal(placementIn(common, 'outputs', RESOURCE_SIGNIFICANCE, []).after.key, 'data_source');
  assert.equal(placementIn(common, 'iam_role', RESOURCE_SIGNIFICANCE, []).before.key, 'data_source');
  const devOrder = ['schema_version', 'env', 'locals', 'airflow', 'iam_role', 'connectivity', 'data_source'];
  assert.equal(placementIn(common, 'iam_role', RESOURCE_SIGNIFICANCE, [devOrder]).after.key, 'airflow');
  const resourcesOnly = mapOf(['schema_version', 'airflow', 'connectivity']);
  assert.equal(placementIn(resourcesOnly, 'iam_role', RESOURCE_SIGNIFICANCE, [devOrder]).before.key, 'connectivity');
  assert.equal(placementIn(mapOf(['outputs']), 'data_source', RESOURCE_SIGNIFICANCE, []).before.key, 'outputs');
  assert.equal(placementIn(mapOf(['airflow']), 'schema_version', RESOURCE_SIGNIFICANCE, []).before.key, 'airflow');
});

test('a key\'s spacing is the blank lines around it in the first source holding it', () => {
  const spaced = docOf('schema_version: "3"\nenv: dev\n\n\ndata_source:\n  kms: x\n\noutputs:\n  a: 1\n');
  const tight = docOf('env: staging\ndata_source:\n  kms: x\noutputs:\n  a: 1\n');
  assert.deepEqual(sourceSpacingOf([spaced, tight], ['data_source']), { blankLinesAbove: 2, blankLinesBelow: 1 });
  assert.deepEqual(sourceSpacingOf([tight, spaced], ['data_source']), { blankLinesAbove: 0, blankLinesBelow: 0 });
  assert.deepEqual(sourceSpacingOf([spaced], ['outputs']), { blankLinesAbove: 1, blankLinesBelow: 0 });
  assert.deepEqual(sourceSpacingOf([spaced], ['missing']), NO_BLANK_LINES);
});

test('an insertion takes its source spacing, counting the blank lines already beside it, and none at the file\'s ends', () => {
  const spacing = { blankLinesAbove: 1, blankLinesBelow: 1 };
  const placed = (placement) => () => ({ ...placement, spacing });
  const block = (indent) => [`${' '.repeat(indent)}data_source: {}`];
  const atEnd = docOf('schema_version: "3"\nrds:\n  a: 1\n');
  const afterRds = placed({ after: atEnd.tree.entries[1] });
  const appended = insertionUnder(atEnd, ['data_source'], ['data_source'], block, afterRds);
  assert.equal(applyEdits(atEnd.text, [appended]), 'schema_version: "3"\nrds:\n  a: 1\n\ndata_source: {}\n');
  const between = docOf('rds:\n  a: 1\n\noutputs: {}\n');
  const beforeOutputs = placed({ before: between.tree.entries[1] });
  const inserted = insertionUnder(between, ['data_source'], ['data_source'], block, beforeOutputs);
  assert.equal(applyEdits(between.text, [inserted]), 'rds:\n  a: 1\n\ndata_source: {}\n\noutputs: {}\n');
  const atTop = docOf('rds:\n  a: 1\n');
  const first = insertionUnder(atTop, ['env'], ['env'], (indent) => [`${' '.repeat(indent)}env: dev`],
    placed({ before: atTop.tree.entries[0] }));
  assert.equal(applyEdits(atTop.text, [first]), 'env: dev\n\nrds:\n  a: 1\n');
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

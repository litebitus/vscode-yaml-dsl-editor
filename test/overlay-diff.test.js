const test = require('node:test');
const assert = require('node:assert/strict');
const { overlayDiffLines, selectedKeyPaths } = require('../lib/overlay-diff');
const { parseYaml } = require('../lib/tree');

function overlaysOf(valuesByOverlay) {
  return Object.entries(valuesByOverlay).map(([overlayName, value]) => ({ overlayName, value }));
}

function shownLines(lines) {
  return lines.map((line) => {
    const marker = line.differenceIndex === null ? ' ' : String(line.differenceIndex);
    const struck = line.struck ? ` [struck ${line.text.slice(line.struck.start, line.struck.end)}]` : '';
    return `${marker} ${line.text}${struck}`;
  });
}

const sharedBlock = {
  label: 'mock-shared',
  size: 1,
  retention: { days: 7, tier: 'standard' },
  tags: ['a'],
};

test('a line every overlay folds alike is written once, and a differing key once per value in overlay order', () => {
  const overlays = overlaysOf({
    'overlay-1': { mocktype: { shared: sharedBlock } },
    'overlay-2': { mocktype: { shared: { ...sharedBlock, size: 2 } } },
    'overlay-3': { mocktype: { shared: sharedBlock } },
  });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['mocktype', 'shared']])), [
    '  # overlay-1, overlay-2, overlay-3: 1 difference',
    '  mocktype:',
    '    shared:',
    '      label: mock-shared',
    '0     size: 1  # overlay-1, overlay-3',
    '0     size: 2  # overlay-2',
    '      retention:',
    '        days: 7',
    '        tier: standard',
    '      tags: [a]',
  ]);
});

test('the first line names the overlays diffed, and says so when nothing differs', () => {
  const overlays = overlaysOf({
    'overlay-1': { mocktype: { shared: sharedBlock } },
    'overlay-3': { mocktype: { shared: sharedBlock } },
  });
  const [header, ...rest] = shownLines(overlayDiffLines(overlays, [['mocktype', 'shared', 'size']]));
  assert.equal(header, '  # overlay-1, overlay-3: no differences');
  assert.deepEqual(rest, ['  mocktype:', '    shared:', '      size: 1']);
});

test('a key an overlay lacks is struck at its leaf among that key\'s lines, its parents plain', () => {
  const { retention, ...withoutRetention } = sharedBlock;
  assert.ok(retention);
  const overlays = overlaysOf({
    'overlay-1': { mocktype: { shared: sharedBlock } },
    'overlay-2': { mocktype: { shared: withoutRetention } },
  });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['mocktype', 'shared']])), [
    '  # overlay-1, overlay-2: 2 differences',
    '  mocktype:',
    '    shared:',
    '      label: mock-shared',
    '      size: 1',
    '      retention:',
    '0       days: 7  # overlay-1',
    '0       days:  # overlay-2 [struck days:]',
    '1       tier: standard  # overlay-1',
    '1       tier:  # overlay-2 [struck tier:]',
    '      tags: [a]',
  ]);
});

test('a selected block an overlay lacks is struck once above it, and the lines below diff the overlays holding it', () => {
  const overlays = overlaysOf({
    'overlay-1': { mocktype: { queue: { name: 'mock-queue', size: 10 } } },
    'overlay-2': { mocktype: { queue: { name: 'mock-queue', size: 20 } } },
    'overlay-3': { mocktype: {} },
  });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['mocktype', 'queue']])), [
    '  # overlay-1, overlay-2, overlay-3: 2 differences',
    '  mocktype:',
    '0   queue:  # overlay-3 [struck queue:]',
    '    queue:',
    '      name: mock-queue',
    '1     size: 10  # overlay-1',
    '1     size: 20  # overlay-2',
  ]);
});

test('a selected value some overlays lack is labeled with its holders and struck for the rest, written as authored', () => {
  const overlays = overlaysOf({
    'overlay-1': { locals: { queue: 'mock-${env}.fifo', links: '${local.bucket}/links/*' } },
    'overlay-2': { locals: { links: '${local.bucket}/links/*' } },
    'overlay-3': { locals: { links: '${local.bucket}/links/*' } },
  });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['locals', 'queue'], ['locals', 'links']])), [
    '  # overlay-1, overlay-2, overlay-3: 1 difference',
    '  locals:',
    '0   queue: mock-${env}.fifo  # overlay-1',
    '0   queue:  # overlay-2, overlay-3 [struck queue:]',
    '    links: ${local.bucket}/links/*',
  ]);
});

test('a list or map value, and a key whose value changes kind, is written in flow style', () => {
  const overlays = overlaysOf({
    'overlay-1': { mocktype: { ports: [80, 443], limits: { cpu: 2 }, empty: {} } },
    'overlay-2': { mocktype: { ports: [443], limits: 'none', empty: {} } },
  });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['mocktype']])), [
    '  # overlay-1, overlay-2: 2 differences',
    '  mocktype:',
    '0   ports: [80, 443]  # overlay-1',
    '0   ports: [443]  # overlay-2',
    '1   limits: {cpu: 2}  # overlay-1',
    '1   limits: none  # overlay-2',
    '    empty: {}',
  ]);
});

test('keys follow the first overlay\'s order, then the keys only later overlays hold', () => {
  const overlays = overlaysOf({
    'overlay-1': { block: { second: 1, first: 1 } },
    'overlay-2': { block: { first: 1, second: 1, third: 1 } },
  });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['block']])), [
    '  # overlay-1, overlay-2: 1 difference',
    '  block:',
    '    second: 1',
    '    first: 1',
    '0   third: 1  # overlay-2',
    '0   third:  # overlay-1 [struck third:]',
  ]);
});

test('several selected keys share the path above them, written once', () => {
  const overlays = overlaysOf({
    'overlay-1': { mocktype: { shared: { size: 1, tags: ['a'] } }, other: { name: 'x' } },
    'overlay-2': { mocktype: { shared: { size: 2, tags: ['a'] } }, other: { name: 'x' } },
  });
  const selected = [['mocktype', 'shared', 'size'], ['mocktype', 'shared', 'tags'], ['other']];
  assert.deepEqual(shownLines(overlayDiffLines(overlays, selected)), [
    '  # overlay-1, overlay-2: 1 difference',
    '  mocktype:',
    '    shared:',
    '0     size: 1  # overlay-1',
    '0     size: 2  # overlay-2',
    '      tags: [a]',
    '  other:',
    '    name: x',
  ]);
});

test('a key no checked overlay holds is struck with every overlay, and a quoted key keeps its quotes', () => {
  const overlays = overlaysOf({ 'overlay-1': { block: {} }, 'overlay-2': { block: {} } });
  assert.deepEqual(shownLines(overlayDiffLines(overlays, [['block', 'true']])), [
    '  # overlay-1, overlay-2: 1 difference',
    '  block:',
    '0   "true":  # overlay-1, overlay-2 [struck "true":]',
  ]);
});

const selectionText = [
  'mocktype:',
  '  shared:',
  '    label: mock-shared',
  '    size: 1',
  '    retention:',
  '      days: 7',
  '    tags:',
  '      - a',
  '    limits: { cpu: 2 }',
  'other:',
  '',
].join('\n');

function rangeOf(startLine, startCharacter, endLine, endCharacter) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

test('the selected lines decide the keys, the outermost key covering what it holds', () => {
  const { tree } = parseYaml(selectionText);
  assert.deepEqual(selectedKeyPaths(tree, rangeOf(3, 0, 5, 3)), [
    ['mocktype', 'shared', 'size'],
    ['mocktype', 'shared', 'retention'],
  ]);
  assert.deepEqual(selectedKeyPaths(tree, rangeOf(1, 0, 2, 0)), [['mocktype', 'shared']]);
  assert.deepEqual(selectedKeyPaths(tree, rangeOf(5, 0, 5, 4)), [['mocktype', 'shared', 'retention', 'days']]);
  assert.deepEqual(selectedKeyPaths(tree, rangeOf(7, 2, 8, 4)), [
    ['mocktype', 'shared', 'tags'],
    ['mocktype', 'shared', 'limits'],
  ]);
  assert.deepEqual(selectedKeyPaths(tree, rangeOf(8, 0, 9, 3)), [['mocktype', 'shared', 'limits'], ['other']]);
  assert.deepEqual(selectedKeyPaths(tree, rangeOf(10, 0, 10, 0)), []);
  assert.deepEqual(selectedKeyPaths(parseYaml('- a\n').tree, rangeOf(0, 0, 0, 3)), []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, completionAt } = require('../lib/analyze');
const { markerFunction, dslEntry, parsedDsl } = require('./config-builders');

const dsl = parsedDsl(dslEntry('called', {
  function: markerFunction({ definitions: ['schema'] }),
  tag_keys: [{ tag: '!Merge', key: 'fn.merge' }, { tag: '!Mock', key: 'mock' }],
}));
const table = {
  merge: {
    description: 'Merges the mock contents.',
    arguments: [{ name: 'contents', type: 'map', required: true, repeated: true, description: 'The mock contents.' }],
    return: { type: 'map', description: 'The mock merged map.' },
    macro: null,
  },
};

function itemsAt(lineText) {
  const doc = analyzeDocument(`mocktype:\n${lineText}\n`, '/repo/mock.yml', dsl);
  const stack = { symbols: [], common: '/repo/mock.yml', files: new Map(), dsl, vocabulary: { table } };
  return completionAt(doc, lineText, { line: 1, character: lineText.length }, stack);
}

function labelsAt(lineText) {
  return itemsAt(lineText).map((item) => [item.label, item.range.start.character]);
}

test('a function is offered where a key starts, from the first character typed, before or after the call marker',
  () => {
  assert.deepEqual(labelsAt('  me'), [['fn.merge', 2]]);
  assert.deepEqual(labelsAt('  FN.ME'), [['fn.merge', 2]]);
  assert.deepEqual(labelsAt('  fn.'), [['fn.merge', 2]]);
  assert.deepEqual(labelsAt('  - me'), [['fn.merge', 4]]);
  assert.deepEqual(labelsAt('  named fn.me'), [['fn.merge', 8]]);
  assert.deepEqual(labelsAt('  mock: me'), []);
  assert.deepEqual(labelsAt('  mock: fn.me'), []);
});

test('a tag the config declares is offered where a value starts with `!`, documented by the function its key calls',
  () => {
  assert.deepEqual(labelsAt('  mock: !'), [['!Merge', 8], ['!Mock', 8]]);
  assert.deepEqual(labelsAt('  - !Me'), [['!Merge', 4], ['!Mock', 4]]);
  assert.deepEqual(labelsAt('  mock: [!'), [['!Merge', 9], ['!Mock', 9]]);
  assert.deepEqual(labelsAt('  mock: me'), []);
  const [merge, mock] = itemsAt('  mock: !');
  assert.equal(merge.detail, 'merge(...contents: map): map');
  assert.match(merge.documentation, /Merges the mock contents\./);
  assert.deepEqual([mock.detail, mock.documentation], ['mock', '']);
});

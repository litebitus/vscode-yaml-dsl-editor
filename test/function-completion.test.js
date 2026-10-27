const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, completionAt } = require('../lib/analyze');
const { markerFunction, dslEntry, parsedDsl } = require('./config-builders');

const dsl = parsedDsl(dslEntry('called', {
  function: markerFunction({
    definitions: ['schema'],
    calls_not_allowed_at: [{ path: '$.refused..*', skip_keys: [] }],
  }),
  tag_keys: [{ tag: '!Merge', key: 'fn.merge' }, { tag: '!Mock', key: 'mock' }],
}));
const table = {
  merge: {
    description: 'Merges the mock contents.',
    arguments: [{ name: 'contents', type: 'map', required: true, repeated: true, description: 'The mock contents.' }],
    return: { type: 'map', description: 'The mock merged map.' },
    macro: null,
  },
  repeat: {
    description: 'Repeats the mock body.',
    arguments: [{ name: 'body', type: 'map', required: true, repeated: false, description: 'The mock body.' }],
    return: { type: 'map', description: 'The mock repeated map.' },
    macro: { kind: 'loop', nameSuffixPattern: null, unmarkedKeyPaths: [], roles: { body: 'body' } },
  },
};

function itemsAt(text, line, lineText = text.split('\n')[line]) {
  const doc = analyzeDocument(text, '/repo/mock.yml', dsl);
  const stack = { symbols: [], common: '/repo/mock.yml', files: new Map(), dsl, vocabulary: { table } };
  return completionAt(doc, lineText, { line, character: lineText.length }, stack);
}

function labelsAt(lineText, textAfter = '') {
  const text = `mocktype:\n${lineText}\n${textAfter}`;
  return itemsAt(text, 1).map((item) => [item.label, item.range.start.character]);
}

test('a function is offered only once the call marker is typed where a key starts', () => {
  assert.deepEqual(labelsAt('  me'), []);
  assert.deepEqual(labelsAt('  - me'), []);
  assert.deepEqual(labelsAt('  mock: fn.me'), []);
  assert.deepEqual(labelsAt('  fn.'), [['fn.merge', 2], ['fn.repeat', 2]]);
});

test('a call with a name is offered every function and macro', () => {
  assert.deepEqual(labelsAt('  named fn.', '  sibling: 1\n'), [['fn.merge', 8], ['fn.repeat', 8]]);
});

test('a call with no name beside other keys is offered only the macros, whose call stands as a whole key', () => {
  assert.deepEqual(labelsAt('  fn.', '  sibling: 1\n'), [['fn.repeat', 2]]);
});

test('a call with no name as the only key of a list item is offered every function', () => {
  assert.deepEqual(labelsAt('  - fn.'), [['fn.merge', 4], ['fn.repeat', 4]]);
});

test('a key where calls are not allowed is offered no function', () => {
  const text = 'refused:\n  inner:\n    fn.\n';
  assert.deepEqual(itemsAt(text, 2).map((item) => item.label), []);
});

test('a tag the config declares is offered where a value starts with `!`, documented by the function its key calls',
  () => {
  assert.deepEqual(labelsAt('  mock: !'), [['!Merge', 8], ['!Mock', 8]]);
  assert.deepEqual(labelsAt('  - !Me'), [['!Merge', 4], ['!Mock', 4]]);
  assert.deepEqual(labelsAt('  mock: [!'), [['!Merge', 9], ['!Mock', 9]]);
  assert.deepEqual(labelsAt('  mock: me'), []);
  const [merge, mock] = itemsAt('mocktype:\n  mock: !\n', 1);
  assert.equal(merge.detail, 'merge(...contents: map): map');
  assert.match(merge.documentation, /Merges the mock contents\./);
  assert.deepEqual([mock.detail, mock.documentation], ['mock', '']);
});

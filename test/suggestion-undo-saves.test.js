const test = require('node:test');
const assert = require('node:assert/strict');
const { APPLIED_FILE_STATES_CAPACITY, createSuggestionUndoSaves } = require('../lib/suggestion-undo-saves');
const { textHashOf } = require('../lib/text-hash');

const devUri = 'file:///repo/dev/mock.yml';
const commonUri = 'file:///repo/mock.yml';
const beforeText = 'queue:\n  events: 1\n';
const afterText = 'queue: {}\n';

function mockDocument(uri, text, options = {}) {
  const document = {
    uri: { toString: () => uri },
    isDirty: options.isDirty === undefined ? true : options.isDirty,
    getText: () => text,
    saves: 0,
    async save() {
      document.saves += 1;
      if (options.saveError) throw options.saveError;
      return true;
    },
  };
  return document;
}

const appliedFile = (uri) => ({
  uri,
  textHashBefore: textHashOf(beforeText),
  textHashAfter: textHashOf(afterText),
});

test('an undo or redo that lands a file on the text before or after an apply saves it', async () => {
  const undoSaves = createSuggestionUndoSaves();
  undoSaves.recordApply([appliedFile(devUri), appliedFile(commonUri)]);
  const undone = mockDocument(devUri, beforeText);
  assert.equal(await undoSaves.documentChanged(undone, true), true);
  assert.equal(undone.saves, 1);
  const redone = mockDocument(commonUri, afterText);
  assert.equal(await undoSaves.documentChanged(redone, true), true);
  assert.equal(redone.saves, 1);
});

test('an undo the editor marks dirty in a later change is saved then, unless the text moved on', async () => {
  const undoSaves = createSuggestionUndoSaves();
  undoSaves.recordApply([appliedFile(devUri)]);
  assert.equal(await undoSaves.documentChanged(mockDocument(devUri, beforeText, { isDirty: false }), true), false);
  const markedDirty = mockDocument(devUri, beforeText);
  assert.equal(await undoSaves.documentChanged(markedDirty, false), true);
  assert.equal(markedDirty.saves, 1);
  assert.equal(await undoSaves.documentChanged(mockDocument(devUri, beforeText, { isDirty: false }), true), false);
  const typedOver = mockDocument(devUri, 'queue:\n  events: 7\n');
  assert.equal(await undoSaves.documentChanged(typedOver, false), false);
  const typedAgain = mockDocument(devUri, beforeText);
  assert.equal(await undoSaves.documentChanged(typedAgain, false), false);
  assert.equal(typedOver.saves + typedAgain.saves, 0);
});

test('a typed edit, an undo landing elsewhere and an unapplied file are left unsaved', async () => {
  const undoSaves = createSuggestionUndoSaves();
  undoSaves.recordApply([appliedFile(devUri)]);
  const documents = [
    [mockDocument(devUri, beforeText), false],
    [mockDocument(devUri, 'queue:\n  events: 7\n'), true],
    [mockDocument('file:///repo/other.yml', beforeText), true],
  ];
  for (const [document, changedByUndoOrRedo] of documents) {
    assert.equal(await undoSaves.documentChanged(document, changedByUndoOrRedo), false);
    assert.equal(document.saves, 0);
  }
});

test('a save that fails is logged', async () => {
  const logged = [];
  const undoSaves = createSuggestionUndoSaves({ logError: (message) => logged.push(message) });
  undoSaves.recordApply([appliedFile(devUri)]);
  const document = mockDocument(devUri, beforeText, { saveError: new Error('mock locked') });
  assert.equal(await undoSaves.documentChanged(document, true), false);
  assert.deepEqual(logged, [`saving ${devUri} after an undo or redo failed: mock locked`]);
});

test('the oldest applied file states are dropped past the capacity', async () => {
  const undoSaves = createSuggestionUndoSaves();
  undoSaves.recordApply([appliedFile(devUri)]);
  const others = Array.from(
    { length: APPLIED_FILE_STATES_CAPACITY },
    (_, index) => appliedFile(`file:///repo/${index}.yml`),
  );
  undoSaves.recordApply(others);
  assert.equal(await undoSaves.documentChanged(mockDocument(devUri, beforeText), true), false);
  assert.equal(await undoSaves.documentChanged(mockDocument('file:///repo/0.yml', beforeText), true), true);
});

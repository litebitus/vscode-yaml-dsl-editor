const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  fixtureCopy,
  typedAfter,
  completionItemsAt,
  positionInText,
  definitionLineAt,
  extensionClient,
  paintedProblemMessagesBecome,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const KEY_REFERENCES_FILE = 'mock-keys.yaml';

function keyReferencesFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'key-references', KEY_REFERENCES_FILE);
}

const labelOf = (item) => (typeof item.label === 'string' ? item.label : item.label.label);

async function referenceKindAt(doc, line, character) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let kind = null;
  while (Date.now() < deadline) {
    const answer = await (await extensionClient())
      .sendRequest('yaml-dsl/decorations', { uri: doc.uri.toString() });
    const found = (answer.references || [])
      .find((reference) => reference.range.start.line === line
        && reference.range.start.character === character);
    kind = found ? found.kind : null;
    if (kind) return kind;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return kind;
}

suite('references in keys', () => {
  isolateEachTest();

  test('a key being typed offers the names a reference rule reads', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('key-references'), KEY_REFERENCES_FILE));
    const cursor = await typedAfter(editor, '  mock_unknown: 1', '\n  ref mocktype.mo');
    const offered = (await completionItemsAt(editor.document, cursor)).map(labelOf);
    assert.ok(offered.includes('ref mocktype.mock_primary'), offered.join(', '));
  });

  test('go to definition from a reference that is a whole key opens its declaration', async () => {
    const doc = (await shownDocument(keyReferencesFixture())).document;
    const keyReference = positionInText(doc, 'ref mocktype.mock_primary:', 'ref '.length);
    assert.equal(await definitionLineAt(doc, keyReference), 3);
  });

  test('a reference in a key that nothing declares is an error', async () => {
    const doc = (await shownDocument(keyReferencesFixture())).document;
    assert.equal(await referenceKindAt(doc, 7, 2), 'error');
    assert.equal(await referenceKindAt(doc, 5, 2), 'local');
  });

  test('rename from a key reference updates the declaration and every reference, keys included', async () => {
    const doc = (await shownDocument(keyReferencesFixture())).document;
    await definitionLineAt(doc, positionInText(doc, 'ref mocktype.mock_primary:', 'ref '.length));
    const renamedAt = positionInText(doc, 'ref mocktype.mock_primary:', 'ref mocktype.'.length);
    const edit = await vscode.commands.executeCommand(
      'vscode.executeDocumentRenameProvider',
      doc.uri,
      renamedAt,
      'mock_main',
    );
    const edits = edit.get(doc.uri).map((textEdit) => [textEdit.range.start.line, textEdit.newText]);
    assert.deepEqual(edits.sort((left, right) => left[0] - right[0]), [
      [1, 'mock_main'],
      [3, 'mock_main'],
      [5, 'mock_main'],
      [12, 'mock_main'],
    ]);
  });

  test('a deferred key\'s map raises no property or required problem, '
    + 'while a sibling\'s problem shows', async () => {
    const doc = (await shownDocument(keyReferencesFixture())).document;
    await paintedProblemMessagesBecome(doc, ['`mock_unknown` is not defined in the schema']);
  });
});

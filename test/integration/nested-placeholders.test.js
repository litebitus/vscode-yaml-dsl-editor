const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { shownDocument, positionInText, definitionLineAt, hoverTextBecomes } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function nestedPlaceholdersFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'nested-placeholders', 'mock-nested.yaml');
}

suite('nested placeholders', () => {
  isolateEachTest();

  test('a placeholder inside a placeholder\'s body is read as its own, and the outer one as the local its rule reads',
    async () => {
      const doc = (await shownDocument(nestedPlaceholdersFixture())).document;
      await hoverTextBecomes(doc, positionInText(doc, '${region}', 3), '`region`: *builtin*');
      assert.equal(await definitionLineAt(doc, positionInText(doc, 'local.buckets.${region}', 'local.'.length + 1)), 1);
    });
});

const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { shownDocument, positionInText, definitionLineAt } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function placeholderNamesFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'placeholder-names', 'mock-names.yaml');
}

suite('placeholder names', () => {
  isolateEachTest();

  test('a key holding a path into a local is reached by the value at that path, and by a ref holding a placeholder',
    async () => {
      const doc = (await shownDocument(placeholderNamesFixture())).document;
      assert.equal(await definitionLineAt(doc, positionInText(doc, 'ref mocktype.mock_api', 'ref '.length)), 5);
      const byPlaceholder = positionInText(doc, 'ref mocktype.${local.mock_id}_api', 'ref '.length);
      assert.equal(await definitionLineAt(doc, byPlaceholder), 5);
    });
});

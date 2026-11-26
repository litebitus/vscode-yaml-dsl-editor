const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { shownDocument, positionInText, definitionLineAt } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function loopDeclarationsFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'loop-declarations', 'mock-loop.yaml');
}

suite('loop declarations', () => {
  isolateEachTest();

  test('a reference reaches the name declared explicitly while a loop key could spell the same name', async () => {
    const doc = (await shownDocument(loopDeclarationsFixture())).document;
    const explicitReference = positionInText(doc, 'ref mocktype.mock_a', 'ref '.length);
    assert.equal(await definitionLineAt(doc, explicitReference), positionInText(doc, '  mock_a:').line);
  });

  test('a name nothing else declares reaches the loop key that could spell it', async () => {
    const doc = (await shownDocument(loopDeclarationsFixture())).document;
    const patternReference = positionInText(doc, 'ref mocktype.mock_other', 'ref '.length);
    assert.equal(await definitionLineAt(doc, patternReference), positionInText(doc, '"mock_${~name}":').line);
  });
});

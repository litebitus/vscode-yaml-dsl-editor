const path = require('path');
const vscode = require('vscode');
const { shownDocument, paintedProblemMessagesBecome } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function calledLocalsFixture(...parts) {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'called-locals', ...parts);
}

suite('paths into call results', () => {
  isolateEachTest();

  test('a path into a local declared by a call, or through a key holding a call, is no problem, and a step the '
    + 'value lacks beside them is', async () => {
    const doc = (await shownDocument(calledLocalsFixture('mock.yaml'))).document;
    await paintedProblemMessagesBecome(doc, ['`local.defaults` holds no `missing`']);
  });
});

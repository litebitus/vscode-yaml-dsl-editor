const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  SAME_IN_COMMON_LAYER,
  MOVE_TO_COMMON_LAYER,
  shownDocument,
  hintLabelsBecome,
} = require('./editor-hints');

suite('saved suggestions', () => {
  test('suggestions another build saved never show, and the running build works their file out again', async () => {
    const writableFolder = vscode.workspace.workspaceFolders[1].uri.fsPath;
    const overlay = (await shownDocument(path.join(writableFolder, 'planted-marks', 'one', 'mock.yml'))).document;
    const seenLabels = await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
    assert.equal(seenLabels.has(MOVE_TO_COMMON_LAYER), false);
  });
});

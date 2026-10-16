const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  SAME_IN_COMMON_LAYER,
  MOVE_TO_COMMON_LAYER,
  shownDocument,
  hintLabelsOf,
  hintLabelsBecome,
  undoInEditorOf,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const SHARED_BLOCK = 'mocktype:\n  shared:\n    size: 1\n';
const SAVED_FILE_SETTLE_MILLISECONDS = 1000;

function writtenStack(name) {
  const root = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, name);
  for (const overlay of ['one', 'two']) {
    fs.mkdirSync(path.join(root, overlay), { recursive: true });
    fs.writeFileSync(path.join(root, overlay, 'mock.yml'), SHARED_BLOCK);
  }
  fs.writeFileSync(path.join(root, 'mock.yml'), SHARED_BLOCK);
  return { commonPath: path.join(root, 'mock.yml'), overlayPath: path.join(root, 'one', 'mock.yml') };
}

suite('layer files changing on disk', () => {
  isolateEachTest();

  test('a common layer removed from disk while its tab is open leaves the stack, and comes back with the file', async () => {
    const { commonPath, overlayPath } = writtenStack('removed-while-open');
    await shownDocument(commonPath);
    const overlay = (await shownDocument(overlayPath)).document;
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
    fs.renameSync(commonPath, `${commonPath}.away`);
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
    fs.renameSync(`${commonPath}.away`, commonPath);
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
  });

  test('closing the tab of a common layer removed from disk while it held unsaved edits leaves the stack without it', async () => {
    const { commonPath, overlayPath } = writtenStack('closed-unsaved');
    const overlay = (await shownDocument(overlayPath)).document;
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
    const commonEditor = await shownDocument(commonPath);
    await commonEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), '# mock unsaved edit\n'));
    fs.renameSync(commonPath, `${commonPath}.away`);
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    assert.deepEqual(await hintLabelsOf(overlay), [SAME_IN_COMMON_LAYER]);
    await undoInEditorOf(commonEditor.document);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
  });

  test('saving an edited layer file keeps its suggestions', async () => {
    const { overlayPath } = writtenStack('saved-after-edit');
    const overlayEditor = await shownDocument(overlayPath);
    const overlay = overlayEditor.document;
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
    await overlayEditor.edit((builder) => builder.insert(new vscode.Position(3, 0), '# mock comment\n'));
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
    await overlay.save();
    await new Promise((resolve) => { setTimeout(resolve, SAVED_FILE_SETTLE_MILLISECONDS); });
    assert.deepEqual(await hintLabelsOf(overlay), [SAME_IN_COMMON_LAYER]);
  });
});

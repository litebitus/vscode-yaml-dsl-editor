const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const SAME_IN_COMMON_LAYER = '💡 same in common layer';
const MOVE_TO_COMMON_LAYER = '💡 move to common layer';
const SHARED_BLOCK = 'mocktype:\n  shared:\n    size: 1\n';

function writtenStack(name) {
  const root = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, name);
  for (const overlay of ['one', 'two']) {
    fs.mkdirSync(path.join(root, overlay), { recursive: true });
    fs.writeFileSync(path.join(root, overlay, 'mock.yml'), SHARED_BLOCK);
  }
  fs.writeFileSync(path.join(root, 'mock.yml'), SHARED_BLOCK);
  return { commonPath: path.join(root, 'mock.yml'), overlayPath: path.join(root, 'one', 'mock.yml') };
}

async function shownDocument(filePath) {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { preview: false });
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.fsPath, filePath);
  const doc = editor.document;
  const deadline = Date.now() + 8000;
  while (doc.languageId !== 'yaml-dsl' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(doc.languageId, 'yaml-dsl');
  return editor;
}

async function hintLabelsOf(doc) {
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  const hints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', doc.uri, range) || [];
  return hints.map((hint) => hint.label[0].value);
}

async function hintLabelsBecome(doc, expected) {
  const deadline = Date.now() + 15000;
  let labels = [];
  while (Date.now() < deadline) {
    labels = await hintLabelsOf(doc);
    if (labels.length === expected.length && labels.every((label, index) => label === expected[index])) return;
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  assert.deepEqual(labels, expected);
}

suite('layer files changing on disk', () => {
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
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
  });
});

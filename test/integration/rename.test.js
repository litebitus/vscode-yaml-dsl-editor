const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  hintLabelsBecome,
  fixtureCopy,
  hintTooltipOf,
  applyArgumentIn,
} = require('./editor-hints');
const { APPLY_COMMAND } = require('../../lib/suggestion-marks');

const RENAME_DB_TO_STORE = '💡 rename everywhere: db → store';

async function fileTextHolds(filePath, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  while (Date.now() < deadline && !fs.readFileSync(filePath, 'utf8').includes(expected)) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.ok(fs.readFileSync(filePath, 'utf8').includes(expected), fs.readFileSync(filePath, 'utf8'));
}

suite('rename suggestions', () => {
  test('a local renamed by hand in the common layer offers to rename it in every file that references it', async () => {
    const stack = fixtureCopy('stack', 'renamed-local-stack');
    const editor = await shownDocument(path.join(stack, 'mock.yml'));
    const commonLayer = editor.document;
    const declared = commonLayer.positionAt(commonLayer.getText().indexOf('db: mock-value'));
    await editor.edit((edit) => { edit.replace(new vscode.Range(declared, declared.translate(0, 'db'.length)), 'store'); });
    await hintLabelsBecome(commonLayer, [RENAME_DB_TO_STORE]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(commonLayer)));
    await fileTextHolds(path.join(stack, 'mock.yml'), 'label: local.store');
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.store');
    await fileTextHolds(path.join(stack, 'mock.yml'), '  store: mock-value');
    assert.equal(commonLayer.isDirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('rename everywhere saves the file renamed by hand even when the click leaves its text as typed', async () => {
    const stack = fixtureCopy('stack', 'saved-hand-rename-stack');
    const commonPath = path.join(stack, 'mock.yml');
    fs.writeFileSync(commonPath, fs.readFileSync(commonPath, 'utf8').replace('label: local.db', 'label: mock-label'));
    const editor = await shownDocument(commonPath);
    const commonLayer = editor.document;
    const declared = commonLayer.positionAt(commonLayer.getText().indexOf('db: mock-value'));
    await editor.edit((edit) => { edit.replace(new vscode.Range(declared, declared.translate(0, 'db'.length)), 'store'); });
    await hintLabelsBecome(commonLayer, [RENAME_DB_TO_STORE]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(commonLayer)));
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.store');
    await fileTextHolds(commonPath, '  store: mock-value');
    assert.equal(commonLayer.isDirty, false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('one undo takes every file back to before an unsaved hand rename and its rename everywhere', async () => {
    const stack = fixtureCopy('stack', 'undone-rename-stack');
    const editor = await shownDocument(path.join(stack, 'mock.yml'));
    const commonLayer = editor.document;
    const declared = commonLayer.positionAt(commonLayer.getText().indexOf('db: mock-value'));
    await editor.edit((edit) => { edit.replace(new vscode.Range(declared, declared.translate(0, 'db'.length)), 'store'); });
    await hintLabelsBecome(commonLayer, [RENAME_DB_TO_STORE]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(commonLayer)));
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.store');
    await vscode.commands.executeCommand('undo');
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.db');
    await fileTextHolds(path.join(stack, 'mock.yml'), '  db: mock-value');
    assert.ok(commonLayer.getText().includes('label: local.db'));
    await hintLabelsBecome(commonLayer, []);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('one undo takes every file back to before a saved hand rename and its rename everywhere', async () => {
    const stack = fixtureCopy('stack', 'saved-undone-rename-stack');
    const commonPath = path.join(stack, 'mock.yml');
    const editor = await shownDocument(commonPath);
    const commonLayer = editor.document;
    const declared = commonLayer.positionAt(commonLayer.getText().indexOf('db: mock-value'));
    await editor.edit((edit) => { edit.replace(new vscode.Range(declared, declared.translate(0, 'db'.length)), 'store'); });
    await commonLayer.save();
    await hintLabelsBecome(commonLayer, [RENAME_DB_TO_STORE]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(commonLayer)));
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.store');
    await fileTextHolds(commonPath, '  store: mock-value');
    await vscode.commands.executeCommand('undo');
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.db');
    await fileTextHolds(commonPath, '  db: mock-value');
    assert.ok(commonLayer.getText().includes('label: local.db'));
    await hintLabelsBecome(commonLayer, []);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('undoing the rename in an overlay undoes it in the common layer and every overlay alike', async () => {
    const stack = fixtureCopy('stack', 'overlay-undone-rename-stack');
    const editor = await shownDocument(path.join(stack, 'mock.yml'));
    const commonLayer = editor.document;
    const declared = commonLayer.positionAt(commonLayer.getText().indexOf('db: mock-value'));
    await editor.edit((edit) => { edit.replace(new vscode.Range(declared, declared.translate(0, 'db'.length)), 'store'); });
    await hintLabelsBecome(commonLayer, [RENAME_DB_TO_STORE]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(commonLayer)));
    await fileTextHolds(path.join(stack, 'mock.yml'), 'label: local.store');
    await shownDocument(path.join(stack, 'one', 'mock.yml'));
    await vscode.commands.executeCommand('undo');
    await fileTextHolds(path.join(stack, 'one', 'mock.yml'), 'label: local.db');
    await fileTextHolds(path.join(stack, 'mock.yml'), '  db: mock-value');
    assert.ok(commonLayer.getText().includes('label: local.db'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});

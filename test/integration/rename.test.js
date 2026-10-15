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
const { APPLY_COMMAND } = require('../../lib/suggestion-lightbulbs');

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
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('undoing the rename in the file renamed by hand undoes it in every file, and keeps the hand edit', async () => {
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
    assert.ok(commonLayer.getText().includes('  store: mock-value'));
    assert.ok(commonLayer.getText().includes('label: local.db'));
    await hintLabelsBecome(commonLayer, [RENAME_DB_TO_STORE]);
    await vscode.commands.executeCommand('undo');
    assert.ok(commonLayer.getText().includes('  db: mock-value'));
    await hintLabelsBecome(commonLayer, []);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});

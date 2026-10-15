const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, shownDocument } = require('./editor-hints');

function stackCopy() {
  const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const copy = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, `completion-stack-${vscode.version}`);
  fs.cpSync(path.join(fixtures, 'stack'), copy, { recursive: true });
  return copy;
}

async function completionLabelsAt(doc, position) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let labels = [];
  while (Date.now() < deadline) {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
    labels = (list ? list.items : []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    if (labels.length > 0) return labels;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return labels;
}

async function typedAtEnd(editor, text) {
  const doc = editor.document;
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  await editor.edit((edit) => { edit.insert(end, text); });
  return doc.lineAt(doc.lineCount - 1).range.end;
}

suite('completion', () => {
  test('a ref started in an overlay offers the common layer\'s resources', async () => {
    const editor = await shownDocument(path.join(stackCopy(), 'one', 'mock.yml'));
    const cursor = await typedAtEnd(editor, '\n    other: ref mo');
    assert.ok((await completionLabelsAt(editor.document, cursor)).includes('ref mocktype.primary'));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('a ref started inside a quote offers the common layer\'s resources', async () => {
    const editor = await shownDocument(path.join(stackCopy(), 'one', 'mock.yml'));
    const cursor = await typedAtEnd(editor, '\n    other: "ref mo');
    assert.ok((await completionLabelsAt(editor.document, cursor)).includes('ref mocktype.primary'));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('a local started in an overlay offers the common layer\'s locals', async () => {
    const editor = await shownDocument(path.join(stackCopy(), 'one', 'mock.yml'));
    const cursor = await typedAtEnd(editor, '\n    other: loc');
    assert.ok((await completionLabelsAt(editor.document, cursor)).includes('local.db'));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});

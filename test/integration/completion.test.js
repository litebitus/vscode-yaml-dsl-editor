const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, shownDocument } = require('./editor-hints');

function fixtureCopy(fixtureFolder) {
  const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const copyName = `completion-${fixtureFolder}-${vscode.version}`;
  const copy = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, copyName);
  fs.cpSync(path.join(fixtures, fixtureFolder), copy, { recursive: true });
  return copy;
}

function stackCopy() {
  return fixtureCopy('stack');
}

const labelOf = (item) => (typeof item.label === 'string' ? item.label : item.label.label);

async function completionItemsAt(doc, position) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let items = [];
  while (Date.now() < deadline) {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
    items = list ? list.items : [];
    if (items.length > 0) return items;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return items;
}

async function completionLabelsAt(doc, position) {
  return (await completionItemsAt(doc, position)).map(labelOf);
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

suite('schema completion', () => {
  test('a key started in a map offers the schema\'s fields the map does not hold, striking a deprecated one', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
    const cursor = await typedAtEnd(editor, '  se');
    const offered = await completionItemsAt(editor.document, cursor);
    const items = Object.fromEntries(offered.map((item) => [labelOf(item), item]));
    const fixtureFields = ['label', 'legacy', 'mode', 'settings'];
    const offeredFields = Object.keys(items).filter((label) => fixtureFields.includes(label)).sort();
    assert.deepEqual(offeredFields, ['legacy', 'mode', 'settings']);
    assert.ok(items.legacy.tags.includes(vscode.CompletionItemTag.Deprecated));
    assert.equal(items.mode.label.detail, ' [optional] The mock mode.');
    const insertedText = (item) => (typeof item.insertText === 'string' ? item.insertText : item.insertText.value);
    assert.equal(insertedText(items.settings), 'settings:\n    ');
    assert.equal(insertedText(items.mode), 'mode: ');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('a value after a key offers the field\'s enum values', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
    const cursor = await typedAtEnd(editor, '  mode: ');
    const labels = await completionLabelsAt(editor.document, cursor);
    assert.ok(labels.includes('fast') && labels.includes('slow'), JSON.stringify(labels));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});

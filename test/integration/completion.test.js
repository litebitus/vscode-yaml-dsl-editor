const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, shownDocument, fixtureCopy } = require('./editor-hints');

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
  test('a key started in a map offers the schema\'s fields, striking a deprecated one', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
    const cursor = await typedAtEnd(editor, '  se');
    const offered = await completionItemsAt(editor.document, cursor);
    const items = Object.fromEntries(offered.map((item) => [labelOf(item), item]));
    const fixtureFields = ['label', 'legacy', 'mode', 'settings'];
    const offeredFields = Object.keys(items).filter((label) => fixtureFields.includes(label)).sort();
    assert.deepEqual(offeredFields, ['label', 'legacy', 'mode', 'settings']);
    assert.ok(items.legacy.tags.includes(vscode.CompletionItemTag.Deprecated));
    assert.equal(items.mode.label.detail, ' [optional] The mock mode.');
    const insertedText = (item) => (typeof item.insertText === 'string' ? item.insertText : item.insertText.value);
    assert.equal(insertedText(items.settings), 'settings:\n    ');
    assert.equal(insertedText(items.mode), 'mode: ');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('the lone-entry Tab command accepts the entry the list holds', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
    const cursor = await typedAtEnd(editor, '  mode: fa');
    editor.selection = new vscode.Selection(cursor, cursor);
    await completionItemsAt(editor.document, cursor);
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    const typedLine = () => editor.document.lineAt(cursor.line).text;
    while (Date.now() < deadline && typedLine() !== '  mode: fast') {
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await vscode.commands.executeCommand('yaml-dsl-editor.acceptLoneSuggestion');
    }
    assert.equal(typedLine(), '  mode: fast');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('word completion is off in a DSL file', () => {
    const editorSettings = vscode.workspace.getConfiguration('editor', { languageId: 'yaml-dsl' });
    assert.equal(editorSettings.get('wordBasedSuggestions'), 'off');
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

suite('required fields', () => {
  test('Enter after an empty resource key fills its required fields, the cursor at the first value, undone in one step', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('required-fields'), 'mock.yml'));
    const doc = editor.document;
    const keyLine = doc.getText().split('\n').indexOf('  alerts:');
    const keyEnd = doc.lineAt(keyLine).range.end;
    editor.selection = new vscode.Selection(keyEnd, keyEnd);
    const textBefore = doc.getText();
    await vscode.commands.executeCommand('type', { text: '\n' });
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    while (!doc.getText().includes('kms_key_arn:') && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    const filledLines = doc.getText().split('\n').slice(keyLine + 1, keyLine + 6);
    assert.deepEqual(filledLines, [
      '    kms_key_arn: ',
      '    mode: fast',
      '    name: ',
      '    settings:',
      '      ',
    ]);
    assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [keyLine + 1, 17]);
    await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
    assert.equal(doc.getText(editor.selection), 'fast');
    await vscode.commands.executeCommand('leaveSnippet');
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText().includes('kms_key_arn:'), false);
    const throughKeyLine = textBefore.slice(0, textBefore.indexOf('  alerts:') + '  alerts:\n'.length);
    assert.equal(doc.getText().startsWith(throughKeyLine), true);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});

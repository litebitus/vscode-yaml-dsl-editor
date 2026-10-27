const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  fixtureCopy,
  completionItemsAt,
  undoInEditorOf,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function stackCopy() {
  return fixtureCopy('stack');
}

const labelOf = (item) => (typeof item.label === 'string' ? item.label : item.label.label);

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
  isolateEachTest();

  test('a ref started in an overlay offers the common layer\'s declarations', async () => {
    const editor = await shownDocument(path.join(stackCopy(), 'one', 'mock.yml'));
    const cursor = await typedAtEnd(editor, '\n    other: ref mo');
    assert.ok((await completionLabelsAt(editor.document, cursor)).includes('ref mocktype.primary'));
  });

  test('a ref started inside a quote offers the common layer\'s declarations', async () => {
    const editor = await shownDocument(path.join(stackCopy(), 'one', 'mock.yml'));
    const cursor = await typedAtEnd(editor, '\n    other: "ref mo');
    assert.ok((await completionLabelsAt(editor.document, cursor)).includes('ref mocktype.primary'));
  });

  test('a local started in an overlay offers the common layer\'s locals', async () => {
    const editor = await shownDocument(path.join(stackCopy(), 'one', 'mock.yml'));
    const cursor = await typedAtEnd(editor, '\n    other: loc');
    assert.ok((await completionLabelsAt(editor.document, cursor)).includes('local.db'));
  });
});

suite('schema completion', () => {
  isolateEachTest();

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
  });

  test('accepting a map field writes its key and a line one level under it, the key\'s own indentation not added again',
    async () => {
      const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
      const cursor = await typedAtEnd(editor, '  sett');
      editor.selection = new vscode.Selection(cursor, cursor);
      await completionItemsAt(editor.document, cursor);
      const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
      const keyLine = () => editor.document.lineAt(cursor.line).text;
      while (Date.now() < deadline && keyLine() !== '  settings:') {
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await new Promise((resolve) => { setTimeout(resolve, 300); });
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
      }
      assert.equal(keyLine(), '  settings:');
      assert.equal(editor.document.lineAt(cursor.line + 1).text, '    ');
    });

  test('accepting a field with a default writes the default, selected', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
    const cursor = await typedAtEnd(editor, '  enab');
    editor.selection = new vscode.Selection(cursor, cursor);
    await completionItemsAt(editor.document, cursor);
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    const typedLine = () => editor.document.lineAt(cursor.line).text;
    while (Date.now() < deadline && typedLine() !== '  enabled: false') {
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await vscode.commands.executeCommand('acceptSelectedSuggestion');
    }
    assert.equal(typedLine(), '  enabled: false');
    assert.equal(editor.document.getText(editor.selection), 'false');
  });

  test('the modeline\'s schema path is a link that opens the schema', async () => {
    const fixture = fixtureCopy('schema-completion');
    const editor = await shownDocument(path.join(fixture, 'mock.yml'));
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    let schemaLink = null;
    while (!schemaLink && Date.now() < deadline) {
      const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', editor.document.uri) || [];
      schemaLink = links.find((link) => link.target && link.target.fsPath === path.join(fixture, 'mock.schema.json'));
      if (!schemaLink) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.ok(schemaLink);
    assert.equal(editor.document.getText(schemaLink.range), './mock.schema.json');
  });

  test('a schema written on disk is read again, its new field offered without reopening the file', async () => {
    const fixture = fixtureCopy('schema-completion', 'reloaded-schema');
    const schemaPath = path.join(fixture, 'mock.schema.json');
    const editor = await shownDocument(path.join(fixture, 'mock.yml'));
    const cursor = await typedAtEnd(editor, '  ');
    await completionItemsAt(editor.document, cursor);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    schema.properties.mocktype.properties.mock_added = { type: 'string', description: '[optional] Added on disk.' };
    fs.writeFileSync(schemaPath, JSON.stringify(schema));
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    let labels = [];
    while (!labels.includes('mock_added') && Date.now() < deadline) {
      labels = (await completionItemsAt(editor.document, cursor)).map(labelOf);
      if (!labels.includes('mock_added')) await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    assert.ok(labels.includes('mock_added'), JSON.stringify(labels));
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
  });
});

suite('Enter', () => {
  isolateEachTest();

  // The language's Enter rules load after the document switches to it, so Enter
  // is pressed again, undone in between, until the expected line appears.
  async function lineAfterEnterAt(lineText, expected) {
    const editor = await shownDocument(path.join(fixtureCopy('schema-completion'), 'mock.yml'));
    const cursor = await typedAtEnd(editor, `\n${lineText}`);
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    let entered = null;
    while (Date.now() < deadline) {
      editor.selection = new vscode.Selection(cursor, cursor);
      await vscode.commands.executeCommand('type', { text: '\n' });
      entered = { text: editor.document.lineAt(cursor.line + 1).text, character: editor.selection.active.character };
      if (entered.text === expected.text && entered.character === expected.character) break;
      await undoInEditorOf(editor.document);
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    return entered;
  }

  test('Enter after a list item holding a key and a value lines the cursor up with the key, for the item\'s next field',
    async () => {
      const expected = { text: '      ', character: 6 };
      assert.deepEqual(await lineAfterEnterAt('    - resource: a.b', expected), expected);
    });

  test('Enter after a scalar list item keeps the cursor under the item marker, for the next item', async () => {
    const expected = { text: '    ', character: 4 };
    assert.deepEqual(await lineAfterEnterAt('    - mock-a', expected), expected);
  });
});

suite('required fields', () => {
  isolateEachTest();

  test('Enter after an empty entry key fills its required fields, the cursor at the first value, undone in one step', async () => {
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
      '    name: mock-name',
      '    settings:',
      '      ',
    ]);
    assert.deepEqual([editor.selection.active.line, editor.selection.active.character], [keyLine + 1, 17]);
    await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
    assert.equal(doc.getText(editor.selection), 'fast');
    await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
    assert.equal(doc.getText(editor.selection), 'mock-name');
    await vscode.commands.executeCommand('leaveSnippet');
    await undoInEditorOf(doc);
    assert.equal(doc.getText().includes('kms_key_arn:'), false);
    const throughKeyLine = textBefore.slice(0, textBefore.indexOf('  alerts:') + '  alerts:\n'.length);
    assert.equal(doc.getText().startsWith(throughKeyLine), true);
  });
});

const assert = require('assert');
const vscode = require('vscode');

function place(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, needle);
  const line = text.slice(0, index).split('\n').length - 1;
  const character = index - text.lastIndexOf('\n', index - 1) - 1;
  return new vscode.Position(line, character);
}

function hoverText(hovers) {
  return (hovers || []).map((hover) => {
    const contents = hover.contents;
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) {
      return contents.map((item) => (typeof item === 'string' ? item : (item.value || ''))).join('\n');
    }
    return contents.value || '';
  }).join('\n');
}

function referencesPeekCount() {
  return vscode.window.visibleTextEditors.filter((editor) => editor.viewColumn == null).length;
}

async function openOwned(relativePath) {
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, ...relativePath));
  await vscode.window.showTextDocument(doc);
  const deadline = Date.now() + 8000;
  while (doc.languageId !== 'yaml-dsl' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(doc.languageId, 'yaml-dsl');
  return doc;
}

suite('references peek regression', () => {
  test('an out-of-file ref shows the section and does not open the references peek', async () => {
    const doc = await openOwned(['stack', 'one', 'mock.yml']);
    const before = referencesPeekCount();
    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      doc.uri,
      place(doc.getText(), 'ref mocktype.primary'),
    );
    assert.equal(referencesPeekCount(), before);
    assert.ok(hovers && hovers.length > 0);
    const text = hoverText(hovers);
    assert.match(text, /primary/);
    assert.match(text, /label/);
    assert.match(text, /<br>/);
    assert.equal(text.includes('```'), false);
    assert.equal(text.includes('\n'), false);
    assert.match(text, /command:yaml-dsl-editor\.peek\?/);
    assert.match(decodeURIComponent(text), /"startLine":/);
  });

  test('an in-file local shows the section and does not open the references peek', async () => {
    const doc = await openOwned(['stack', 'mock.yml']);
    const before = referencesPeekCount();
    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      doc.uri,
      place(doc.getText(), 'local.db'),
    );
    assert.equal(referencesPeekCount(), before);
    assert.ok(hovers && hovers.length > 0);
    const text = hoverText(hovers);
    assert.match(text, /db/);
    assert.match(text, /mock-value/);
    assert.equal(text.includes('```'), false);
  });
});

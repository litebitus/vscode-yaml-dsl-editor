const assert = require('assert');
const vscode = require('vscode');

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

async function inlayHintsOf(doc) {
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  const deadline = Date.now() + 10000;
  let hints = [];
  while (Date.now() < deadline) {
    hints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', doc.uri, range) || [];
    if (hints.length > 0) return hints;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return hints;
}

suite('common layer suggestions', () => {
  test('a block every overlay holds shows an inlay hint at the end of its key line', async () => {
    const doc = await openOwned(['suggest', 'one', 'mock.yml']);
    const hints = await inlayHintsOf(doc);
    assert.equal(hints.length, 1);
    const [hint] = hints;
    assert.deepEqual([hint.position.line, hint.position.character], [1, '  shared:'.length]);
    const [label] = hint.label;
    assert.equal(label.value, '💡 move to common layer');
    assert.match(label.tooltip.value, /`mocktype\.shared` is common to 2 of 2 overlays/);
    assert.equal(label.command, undefined);
    assert.match(label.tooltip.value, /command:yaml-dsl-editor\.applySuggestion\?/);
  });

  test('inlay hints are on in a DSL file whatever the editor\'s own default', () => {
    const inlayHints = vscode.workspace.getConfiguration('editor', { languageId: 'yaml-dsl' }).inspect('inlayHints.enabled');
    assert.equal(inlayHints.defaultLanguageValue, 'on');
  });
});

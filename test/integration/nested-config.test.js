const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { shownDocument, positionInText, hoverTextBecomes } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const UNCLAIMED_WATCH_MILLISECONDS = 1000;

function nestedConfigFolder() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'nested-config');
}

async function languageStaysOutOfDsl(filePath) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(doc, { preview: false });
  const deadline = Date.now() + UNCLAIMED_WATCH_MILLISECONDS;
  while (Date.now() < deadline) {
    assert.notEqual(doc.languageId, 'yaml-dsl');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

suite('nested config', () => {
  isolateEachTest();

  test('a yaml-dsl.yml below the workspace folder governs it, its schema found through {config_root}', async () => {
    const entry = (await shownDocument(path.join(nestedConfigFolder(), 'deep', 'entry.yaml'))).document;
    await hoverTextBecomes(
      entry,
      positionInText(entry, 'label', 1),
      '```\nlabel: string    [optional]\n```\n\nLabel of the nested DSL',
    );
  });

  test('a file the outer config would own is not claimed in a folder a deeper config governs', async () => {
    await shownDocument(path.join(nestedConfigFolder(), 'deep', 'entry.yaml'));
    await languageStaysOutOfDsl(path.join(nestedConfigFolder(), 'mock.yml'));
  });

  test('a yaml-dsl.yml is never a DSL file', async () => {
    await shownDocument(path.join(nestedConfigFolder(), 'deep', 'entry.yaml'));
    await languageStaysOutOfDsl(path.join(nestedConfigFolder(), 'yaml-dsl.yml'));
  });
});

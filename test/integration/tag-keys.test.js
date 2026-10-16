const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, shownDocument, positionInText, hoverTextBecomes } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function taggedFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'tagged', 'mock.yaml');
}

async function definitionLineBecomes(doc, position, expectedLine) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let lines = [];
  while (Date.now() < deadline) {
    const found = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, position) || [];
    lines = found.map((location) => (location.targetRange || location.range).start.line);
    if (lines.length === 1 && lines[0] === expectedLine) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.deepEqual(lines, [expectedLine]);
}

suite('tag keys', () => {
  isolateEachTest();

  test('a reference opens its declaration in the short form and under the key its tag stands for', async () => {
    const doc = (await shownDocument(taggedFixture())).document;
    const declarationLine = positionInText(doc, 'MockBucket:').line;
    await definitionLineBecomes(doc, positionInText(doc, '!Ref MockBucket', 6), declarationLine);
    await definitionLineBecomes(doc, positionInText(doc, 'Ref: MockBucket', 6), declarationLine);
  });

  test('a tag hovers with the documentation of the key it stands for', async () => {
    const doc = (await shownDocument(taggedFixture())).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, '!Ref MockBucket', 1),
      '```\nRef: string    [optional]\n```\n\nThe logical ID a reference reads.',
    );
  });
});

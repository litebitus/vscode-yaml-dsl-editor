const path = require('path');
const vscode = require('vscode');
const { shownDocument, positionInText, hoverTextBecomes } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function functionTableFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'function-table', 'mock-calls.yaml');
}

suite('function table', () => {
  isolateEachTest();

  test('a function is documented by its signature, its markdown description, each argument\'s description '
    + 'and what it returns', async () => {
    const doc = (await shownDocument(functionTableFixture())).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'fn.ssm', 3),
      '```\nssm(parameter: text): text\n```\n\nReturns the **mock** parameter\'s value.\n\n'
        + '- `parameter`: The mock parameter name.\n\n*Returns:* The mock **value**.',
    );
  });

  test('a function mapped straight to its argument list is documented by its signature and returns void', async () => {
    const doc = (await shownDocument(functionTableFixture())).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'fn.legacy', 3),
      '```\nlegacy(value: text): void\n```\n\n*Returns:* `void`',
    );
  });
});

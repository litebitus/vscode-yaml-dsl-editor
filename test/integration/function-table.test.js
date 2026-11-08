const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  paintedProblemMessagesBecome,
  schemaNoteOf,
} = require('./editor-hints');
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
      '```yaml-dsl-signature\nssm(parameter: text): text\n```\n\nReturns the **mock** parameter\'s value.\n\n'
        + '- `parameter`: The mock parameter name.\n\n*Returns:* The mock **value**.',
    );
  });

  test('a function mapped straight to its argument list is documented by its signature and returns void', async () => {
    const doc = (await shownDocument(functionTableFixture())).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'fn.legacy', 3),
      '```yaml-dsl-signature\nlegacy(value: text): void\n```\n\n*Returns:* `void`',
    );
  });

  test('a list item a call without a name computes is not checked against the item type', async () => {
    const doc = (await shownDocument(functionTableFixture())).document;
    await paintedProblemMessagesBecome(doc, [
      '`mock-list[2]` must be `string`',
      '#/x-yaml-dsl-functions maps a function straight to its arguments, a deprecated form: '
        + 'map each function to its description, arguments and return',
    ]);
  });

  test('a call key naming a field documents that field by its name, and its function by its signature', async () => {
    const doc = (await shownDocument(functionTableFixture())).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'value fn.ssm', 1),
      `\`value\`: *string*    \`[required]\`\n\n${schemaNoteOf('The mock value.')}`,
    );
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'value fn.ssm', 'value fn.'.length + 1),
      '```yaml-dsl-signature\nssm(parameter: text): text\n```\n\nReturns the **mock** parameter\'s value.\n\n'
        + '- `parameter`: The mock parameter name.\n\n*Returns:* The mock **value**.',
    );
  });
});

const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  fixtureCopy,
  positionInText,
  hoverTextBecomes,
  completionItemsAt,
  paintedProblemMessagesBecome,
  schemaTextOf,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function functionTableFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'function-table', 'mock-calls.yaml');
}

const SSM_DOCUMENTATION = '```yaml-dsl-signature\nssm(parameter: text): text\n```\n\n'
  + `${schemaTextOf('Returns the **mock** parameter\'s value.')}\n\n`
  + `*Arguments:*\n- \`parameter\`: ${schemaTextOf('The mock parameter name.')}\n\n`
  + `*Returns:* ${schemaTextOf('The mock **value**.')}`;

suite('function table', () => {
  isolateEachTest();

  test('a function is documented by its signature, then its description, each argument\'s description '
    + 'and what it returns, each as the schema wrote it in the theme\'s color', async () => {
    const doc = (await shownDocument(functionTableFixture())).document;
    await hoverTextBecomes(doc, positionInText(doc, 'fn.ssm', 3), SSM_DOCUMENTATION);
    const [hover] = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      doc.uri,
      positionInText(doc, 'fn.ssm', 3),
    );
    assert.equal(hover.contents[0].supportHtml, true);
  });

  test('a function offered after the call marker carries the hover\'s documentation, rendered with HTML', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('function-table'), 'mock-calls.yaml'));
    const doc = editor.document;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await editor.edit((edit) => { edit.insert(end, '\nmock-typed:\n  fn.'); });
    const offered = await completionItemsAt(doc, doc.lineAt(doc.lineCount - 1).range.end);
    const ssm = offered.find((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'fn.ssm');
    assert.deepEqual([ssm.documentation.value, ssm.documentation.supportHtml], [SSM_DOCUMENTATION, true]);
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
      `\`value\`: *string*\n\n${schemaTextOf('[required] The mock value.')}`,
    );
    await hoverTextBecomes(doc, positionInText(doc, 'value fn.ssm', 'value fn.'.length + 1), SSM_DOCUMENTATION);
  });
});

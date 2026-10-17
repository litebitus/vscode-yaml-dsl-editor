const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { shownDocument, positionInText, hoverTextBecomes } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');
const { mockSchemaServer } = require('../mock-schema-server');

const SIZE_DOCUMENTATION = '`size`: *integer*    `[optional]`\n\nMock size from a URL.';

function stackFileWithModeline(folderLabel, schemaUrl) {
  const folder = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, `${folderLabel}-${vscode.version}`);
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, 'mock.yml');
  fs.writeFileSync(filePath, `# yaml-language-server: $schema=${schemaUrl}\nsize: 1\n`);
  return filePath;
}

suite('schema URL copies', () => {
  const schemaServer = mockSchemaServer();
  isolateEachTest();
  suiteSetup(() => schemaServer.start());
  suiteTeardown(() => schemaServer.stop());
  setup(() => {
    schemaServer.requests.length = 0;
    schemaServer.serve('/url-schema.json', {
      text: JSON.stringify({
        properties: { size: { type: 'integer', description: '[optional] Mock size from a URL.' } },
      }),
      entityTag: '"mock-url-schema"',
    });
  });

  test('a modeline URL with a max age is fetched once without the editor\'s parameter, and its copy serves the next '
    + 'file that names it', async () => {
    const schemaUrl = schemaServer.urlOf('/url-schema.json?mock=1&yaml_dsl_max_age_days=7');
    const first = (await shownDocument(stackFileWithModeline('url-schema-first', schemaUrl))).document;
    await hoverTextBecomes(first, positionInText(first, 'size', 1), SIZE_DOCUMENTATION);
    const second = (await shownDocument(stackFileWithModeline('url-schema-second', schemaUrl))).document;
    await hoverTextBecomes(second, positionInText(second, 'size', 1), SIZE_DOCUMENTATION);
    assert.deepEqual(schemaServer.requests.map((request) => request.path), ['/url-schema.json?mock=1']);
  });
});

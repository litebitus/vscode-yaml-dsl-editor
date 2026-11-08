const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  hoverTextHolds,
  hoverTextOf,
  fixtureCopy,
  typedAfter,
  completionItemsAt,
  paintedProblemMessagesOf,
  schemaTextOf,
  WAIT_DEADLINE_MILLISECONDS,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const DEFINITION_LANGUAGE = 'yaml-dsl-definition';
const FIXTURE = 'config-minor-version';
const LABEL_HOVER = `\`label\`: *string*    \`[optional]\`\n\n${schemaTextOf('Label of the minor-version DSL')}`;

async function configProblemsPainted(configFile) {
  const config = { uri: vscode.Uri.file(configFile) };
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  while (Date.now() < deadline && (await paintedProblemMessagesOf(config)).length === 0) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.notDeepEqual(await paintedProblemMessagesOf(config), []);
}

suite('config reading', () => {
  isolateEachTest();

  test('a yaml-dsl.yml stating version "1.0" governs its folder', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const entry = (await shownDocument(path.join(fixtures, FIXTURE, 'entry.yaml'))).document;
    await hoverTextBecomes(entry, positionInText(entry, 'label', 1), LABEL_HOVER);
  });

  test('a document keeps its DSL while its yaml-dsl.yml holds a problem', async () => {
    const copy = fixtureCopy(FIXTURE, 'config-kept');
    const entry = (await shownDocument(path.join(copy, 'entry.yaml'))).document;
    const label = positionInText(entry, 'label', 1);
    await hoverTextBecomes(entry, label, LABEL_HOVER);
    const configFile = path.join(copy, 'yaml-dsl.yml');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('file_excludes', 'file_exclude'));
    await configProblemsPainted(configFile);
    assert.equal(entry.languageId, 'yaml-dsl');
    assert.ok((await hoverTextOf(entry, label)).includes(LABEL_HOVER));
  });

  test('a yaml-dsl.yml opens as a YAML DSL Definition and hovers by the standard\'s schema at its version', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const config = (await shownDocument(path.join(fixtures, FIXTURE, 'yaml-dsl.yml'), DEFINITION_LANGUAGE)).document;
    await hoverTextHolds(config, positionInText(config, 'file_includes', 1), 'Globs of the files the DSL owns.');
    await hoverTextHolds(config, positionInText(config, 'version', 1), '*One of:* `"1"`, `"1.0"`');
  });

  test('a yaml-dsl.yml completes the fields the standard\'s schema allows', async () => {
    const copy = fixtureCopy(FIXTURE, 'config-completion');
    const editor = await shownDocument(path.join(copy, 'yaml-dsl.yml'), DEFINITION_LANGUAGE);
    const typed = await typedAfter(editor, 'file_excludes', '\n    sch');
    const labels = (await completionItemsAt(editor.document, typed))
      .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.ok(labels.includes('schema_search_paths'), labels.join(', '));
  });
});

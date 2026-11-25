const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  definitionLineAt,
  hoverTextBecomes,
  paintedProblemMessagesBecome,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function templatesFixture(...parts) {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'templates', ...parts);
}

suite('templates', () => {
  isolateEachTest();

  test('an overlay template opens as a template, reads its common layer template, and reports only the '
    + 'template\'s own problem', async () => {
    const doc = (await shownDocument(templatesFixture('templates', 'dev', 'mock.yaml'), 'yaml-dsl-template')).document;
    await paintedProblemMessagesBecome(doc, ['`[[ end ]]` closes no conditional or loop']);
    assert.equal(await definitionLineAt(doc, positionInText(doc, 'ref mocktype.shared', 'ref mocktype.'.length)), 3);
  });

  test('a loop variable leads to its loop, and a template variable hovers as a value the template is rendered '
    + 'with', async () => {
    const doc = (await shownDocument(templatesFixture('templates', 'dev', 'mock.yaml'), 'yaml-dsl-template')).document;
    assert.equal(await definitionLineAt(doc, positionInText(doc, '[[ $item ]]', '[[ '.length)), 6);
    await hoverTextBecomes(doc, positionInText(doc, '.size', 1),
      'template variable `.size`, a value the template is rendered with');
  });
});

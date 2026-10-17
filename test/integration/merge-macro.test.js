const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  definitionLineAt,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function mergeFixture(...parts) {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'merge-macro', ...parts);
}

suite('merge macros', () => {
  isolateEachTest();

  test('a merge call among its map\'s keys, with or without the splat, is documented as the macro', async () => {
    const doc = (await shownDocument(mergeFixture('one', 'mock.yaml'))).document;
    const documentation = '```yaml-dsl-signature\nmacro merge(...contents: map)\n```\n\n'
      + 'Merges the mock contents under the map holding the call.\n\n'
      + '- `contents`: The mock contents.\n\n'
      + '*Expands to:* the map holding the call, merged over `contents` in order.';
    await hoverTextBecomes(doc, positionInText(doc, 'merge: local.mock_wrong'), documentation);
    await hoverTextBecomes(doc, positionInText(doc, 'merge*:'), documentation);
  });

  test('a name a merge brings in from a local resolves where the local declares it', async () => {
    const doc = (await shownDocument(mergeFixture('mock.yaml'))).document;
    assert.equal(
      await definitionLineAt(doc, positionInText(doc, 'ref mocktype.landed', 4)),
      positionInText(doc, '    landed:').line,
    );
  });
});

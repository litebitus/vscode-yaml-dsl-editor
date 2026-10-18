const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  hoverTextHolds,
  typedAfter,
  completionItemsAt,
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

  test('a reference into a local opens the key at its path', async () => {
    const doc = (await shownDocument(mergeFixture('mock.yaml'))).document;
    assert.equal(
      await definitionLineAt(doc, positionInText(doc, 'local.mock_nested.inner', 2)),
      positionInText(doc, '    inner:').line,
    );
  });

  test('a key in a local the common layer merges is documented by each schema it lands under, and completes the '
    + 'fields they share', async () => {
    const editor = await shownDocument(mergeFixture('mock.yaml'));
    const doc = editor.document;
    const unbroken = (term) => [...term].join('⁠');
    const sizePosition = positionInText(doc, 'size: 1', 1);
    await hoverTextHolds(doc, sizePosition, `${unbroken('one:mocktype.{shared,unknown}')}</strong>`);
    await hoverTextHolds(doc, sizePosition, `${unbroken('one:topictype.alerts')}</strong>`);
    await hoverTextHolds(doc, sizePosition, 'The mock topic size.');
    const cursor = await typedAfter(editor, 'size: 1', '\n    ');
    const labels = (await completionItemsAt(doc, cursor))
      .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.deepEqual(labels.filter((label) => ['size', 'mode', 'source'].includes(label)), ['source']);
  });

  test('a reference typed in another case is offered as its rule spells it', async () => {
    const editor = await shownDocument(mergeFixture('mock.yaml'));
    const cursor = await typedAfter(editor, 'source: ref mocktype.landed', '\n  lowered:\n    source: REF');
    const labels = (await completionItemsAt(editor.document, cursor))
      .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.ok(labels.includes('ref mocktype.landed'), labels.join(', '));
  });
});

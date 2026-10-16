const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  WAIT_DEADLINE_MILLISECONDS,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const DEPRECATED_OLD_WARNING = '`old` is deprecated: use pair';

function positionOf(doc, needle) {
  return doc.positionAt(doc.getText().indexOf(needle));
}

function hoverTextOf(hovers) {
  return (hovers || [])
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n');
}

async function hoverTextAt(doc, needle) {
  const position = positionOf(doc, needle);
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let text = '';
  while (Date.now() < deadline) {
    text = hoverTextOf(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, position));
    if (text) return text;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return text;
}

async function draftDocument(draftFolder) {
  const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
  return (await shownDocument(path.join(fixtures, 'drafts', draftFolder, 'mock.yml'))).document;
}

const FIRST_OF_PAIR = '```\npair[0]\n```\n\nthe first of the pair';
const LATER_ITEM = '```\npair[1]\n```\n\nevery later item';
const NAMED_LABEL = '```\nlabel    [optional]\n```\n\nthe named label';
const OLD_USE_PAIR = '```\nold    [optional]\n```\n\nuse pair';

suite('JSON Schema drafts', () => {
  isolateEachTest();

  test('draft-07 hovers a tuple item, its additionalItems and a plain-name $id anchor, and ignores deprecated', async () => {
    const doc = await draftDocument('draft-07');
    assert.equal(await hoverTextAt(doc, 'first'), FIRST_OF_PAIR);
    assert.equal(await hoverTextAt(doc, '2\n'), LATER_ITEM);
    assert.equal(await hoverTextAt(doc, 'label'), NAMED_LABEL);
    assert.equal(await hoverTextAt(doc, 'old'), OLD_USE_PAIR);
  });

  test('draft 2019-09 hovers an $anchor reference, and its warning is the hover of a deprecated field\'s key and value', async () => {
    const doc = await draftDocument('draft-2019-09');
    assert.equal(await hoverTextAt(doc, 'first'), FIRST_OF_PAIR);
    assert.equal(await hoverTextAt(doc, 'label'), NAMED_LABEL);
    await hoverTextBecomes(doc, positionInText(doc, 'old'), DEPRECATED_OLD_WARNING);
    await hoverTextBecomes(doc, positionInText(doc, 'old: ', 'old: '.length), DEPRECATED_OLD_WARNING);
  });

  test('draft 2020-12 hovers prefixItems, items and a $dynamicRef, and its warning is the hover of a deprecated field\'s key and value', async () => {
    const doc = await draftDocument('draft-2020-12');
    assert.equal(await hoverTextAt(doc, 'first'), FIRST_OF_PAIR);
    assert.equal(await hoverTextAt(doc, '2\n'), LATER_ITEM);
    assert.equal(await hoverTextAt(doc, 'label'), NAMED_LABEL);
    await hoverTextBecomes(doc, positionInText(doc, 'old'), DEPRECATED_OLD_WARNING);
    await hoverTextBecomes(doc, positionInText(doc, 'old: ', 'old: '.length), DEPRECATED_OLD_WARNING);
  });

  test('draft 2020-12 hovers a field with what setting it requires, from its holder\'s dependentSchemas', async () => {
    const doc = await draftDocument('draft-2020-12');
    assert.equal(
      await hoverTextAt(doc, 'queue'),
      '```\nqueue: string    [optional]\n```\n\nthe mock queue\n\n*When set:* `role` required, or a `node`.',
    );
  });

  test('a key that sets its entry\'s identity field hovers the entry, then that field\'s documentation', async () => {
    const doc = await draftDocument('draft-2020-12');
    assert.equal(
      await hoverTextAt(doc, 'id mock-entry'),
      '```\nid mock-entry    [optional]\n```\n\na mock entry\n\n*Sets* `id` *to* `mock-entry`:\n\n'
        + '```\nid: string    [optional]\n```\n\nthe entry\'s identity',
    );
  });

  test('a schema declaring an older draft is read as draft-07', async () => {
    const doc = await draftDocument('draft-04');
    assert.equal(await hoverTextAt(doc, 'first'), FIRST_OF_PAIR);
    assert.equal(await hoverTextAt(doc, 'old'), OLD_USE_PAIR);
  });

  test('a schema declaring a draft the editor does not read gives no field hover', async () => {
    const doc = await draftDocument('draft-unknown');
    assert.equal(await hoverTextAt(doc, 'old'), '');
  });
});

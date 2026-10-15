const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { shownDocument, WAIT_DEADLINE_MILLISECONDS } = require('./editor-hints');

function positionOf(doc, needle) {
  return doc.positionAt(doc.getText().indexOf(needle));
}

function hoverTextOf(hovers) {
  return (hovers || [])
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n')
    .replaceAll('&nbsp;', ' ');
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

suite('JSON Schema drafts', () => {
  test('draft-07 hovers a tuple item, its additionalItems and a plain-name $id anchor, and ignores deprecated', async () => {
    const doc = await draftDocument('draft-07');
    assert.equal(await hoverTextAt(doc, 'first'), 'the first of the pair');
    assert.equal(await hoverTextAt(doc, '2\n'), 'every later item');
    assert.equal(await hoverTextAt(doc, 'label'), 'the named label');
    assert.equal(await hoverTextAt(doc, 'old'), 'use pair');
  });

  test('draft 2019-09 hovers an $anchor reference and states a deprecated field', async () => {
    const doc = await draftDocument('draft-2019-09');
    assert.equal(await hoverTextAt(doc, 'first'), 'the first of the pair');
    assert.equal(await hoverTextAt(doc, 'label'), 'the named label');
    assert.equal(await hoverTextAt(doc, 'old'), 'deprecated: use pair');
  });

  test('draft 2020-12 hovers prefixItems, items and a $dynamicRef, and states a deprecated field', async () => {
    const doc = await draftDocument('draft-2020-12');
    assert.equal(await hoverTextAt(doc, 'first'), 'the first of the pair');
    assert.equal(await hoverTextAt(doc, '2\n'), 'every later item');
    assert.equal(await hoverTextAt(doc, 'label'), 'the named label');
    assert.equal(await hoverTextAt(doc, 'old'), 'deprecated: use pair');
  });

  test('a schema declaring an older draft is read as draft-07', async () => {
    const doc = await draftDocument('draft-04');
    assert.equal(await hoverTextAt(doc, 'first'), 'the first of the pair');
    assert.equal(await hoverTextAt(doc, 'old'), 'use pair');
  });

  test('a schema declaring a draft the editor does not read gives no field hover', async () => {
    const doc = await draftDocument('draft-unknown');
    assert.equal(await hoverTextAt(doc, 'old'), '');
  });
});

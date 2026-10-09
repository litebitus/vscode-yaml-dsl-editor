const test = require('node:test');
const assert = require('node:assert/strict');
const { SHOW_DECLARATIONS_COMMAND, createDeclarationsPopup } = require('../lib/declarations-popup');

const commonUri = 'file:///repo/mock.yml';
const linkRange = { start: { line: 4, character: 2 }, end: { line: 4, character: 30 } };
const location = { uri: commonUri, line: 4, character: 2 };

function mockDocument(uri) {
  return { uri: { toString: () => uri } };
}

function editorHost(activeUri = commonUri) {
  const host = { commands: [] };
  host.editor = { document: mockDocument(activeUri), selection: null };
  host.vscode = {
    Uri: { parse: (text) => ({ text }) },
    Position: class {
      constructor(line, character) { this.line = line; this.character = character; }
    },
    Selection: class {
      constructor(anchor, active) { this.anchor = anchor; this.active = active; }
    },
    window: { activeTextEditor: host.editor },
    commands: { executeCommand: async (...args) => { host.commands.push(args); } },
  };
  return host;
}

test('a link to several declarations shows them at the reference', () => {
  const host = editorHost();
  const popup = createDeclarationsPopup(host.vscode);
  const link = popup.declarationsLink(mockDocument(commonUri), { range: linkRange, data: { targetCount: 2 } });
  const prefix = `command:${SHOW_DECLARATIONS_COMMAND}?`;
  assert.ok(link.target.text.startsWith(prefix));
  assert.deepEqual(JSON.parse(decodeURIComponent(link.target.text.slice(prefix.length))), [location]);
});

test('a link to one declaration stays as it is', () => {
  const host = editorHost();
  const popup = createDeclarationsPopup(host.vscode);
  const link = { range: linkRange, target: 'mock-target' };
  assert.equal(popup.declarationsLink(mockDocument(commonUri), link), link);
  assert.equal(link.target, 'mock-target');
});

test('showing puts the cursor on the reference and opens its hover there, once', async () => {
  const host = editorHost();
  const popup = createDeclarationsPopup(host.vscode);
  await popup.show(location);
  const { active } = host.editor.selection;
  assert.deepEqual([active.line, active.character], [4, 2]);
  assert.deepEqual(host.commands, [['editor.action.showHover']]);
  assert.equal(popup.opensHoverAt(mockDocument(commonUri), { line: 4, character: 2 }), true);
  assert.equal(popup.opensHoverAt(mockDocument(commonUri), { line: 4, character: 2 }), false);
});

test('a hover elsewhere is not the one showing opened', async () => {
  const host = editorHost();
  const popup = createDeclarationsPopup(host.vscode);
  assert.equal(popup.opensHoverAt(mockDocument(commonUri), { line: 4, character: 2 }), false);
  await popup.show(location);
  assert.equal(popup.opensHoverAt(mockDocument(commonUri), { line: 5, character: 2 }), false);
  assert.equal(popup.opensHoverAt(mockDocument('file:///repo/two/mock.yml'), { line: 4, character: 2 }), false);
});

test('showing for a file that is not the active editor does nothing', async () => {
  const host = editorHost('file:///repo/two/mock.yml');
  const popup = createDeclarationsPopup(host.vscode);
  await popup.show(location);
  assert.equal(host.editor.selection, null);
  assert.deepEqual(host.commands, []);
});

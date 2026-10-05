const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../lib/bind');

function fakeConnection() {
  const handlers = {};
  return {
    handlers,
    diagnostics: [],
    notifications: [],
    onInitialize(fn) { handlers.initialize = fn; },
    onHover(fn) { handlers.hover = fn; },
    onDefinition(fn) { handlers.definition = fn; },
    onDocumentLinks(fn) { handlers.links = fn; },
    onNotification(method, fn) { handlers[method] = fn; },
    onRequest(method, fn) { handlers[method] = fn; },
    sendDiagnostics(params) { this.diagnostics.push(params); },
    sendNotification(method, params) { this.notifications.push({ method, params }); },
  };
}

function rangeOf(text, needle) {
  const index = text.indexOf(needle);
  const endIndex = index + needle.length;
  const at = (offset) => {
    const line = text.slice(0, offset).split('\n').length - 1;
    const character = offset - text.lastIndexOf('\n', offset - 1) - 1;
    return { line, character };
  };
  return { start: at(index), end: at(endIndex) };
}

function fakeDocuments() {
  const handlers = {};
  return {
    handlers,
    onDidOpen(fn) { handlers.open = fn; },
    onDidChangeContent(fn) { handlers.change = fn; },
    onDidClose(fn) { handlers.close = fn; },
  };
}

test('the default workspace still answers initialize', () => {
  const connection = fakeConnection();
  bind(connection, fakeDocuments());
  const result = connection.handlers.initialize();
  assert.equal(result.capabilities.hoverProvider, true);
  assert.equal(result.capabilities.definitionProvider, true);
  assert.equal(result.capabilities.documentLinkProvider.resolveProvider, false);
});

test('document events publish diagnostics and custom requests answer', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const files = { '/repo/schema.json': '{"description":"root","properties":{"name":{"description":"the name"}}}' };
  bind(connection, documents, {
    readFile: async (filePath) => files[filePath] ?? null,
    fetchText: async () => null,
  });
  await connection.handlers['yaml-dsl/config']({
    entries: [{
      text: 'dsls:\n  - id: resources\n    match: ["**/mock.yml"]\n    schema: schema.json\n',
      dir: '/repo',
    }],
  });
  const text = '# yaml-language-server: $schema=../schema.json\nname: plain\n';
  await documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  await documents.handlers.change({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  const hover = await connection.handlers.hover({ textDocument: { uri: 'file:///repo/app/mock.yml' }, position: { line: 1, character: 0 } });
  assert.equal(hover.contents.value, 'the name');
  const missing = await connection.handlers.definition({ textDocument: { uri: 'file:///repo/app/mock.yml' }, position: { line: 1, character: 0 } });
  assert.equal(missing, null);
  await connection.handlers['yaml-dsl/config']({
    text: 'dsls:\n  - id: note\n    match: ["**/note.yml"]\n    symbols:\n      - kind: local\n        at: "$.locals.*"\n    references:\n      - pattern: "^local"\n        where: whole\n        target: { kind: local }\n',
    dir: '/repo',
  });
  const note = 'locals:\n  db: mock-value\nuse: local.db\n';
  await documents.handlers.open({ document: { uri: 'file:///repo/note.yml', getText: () => note } });
  const hit = await connection.handlers.definition({ textDocument: { uri: 'file:///repo/note.yml' }, position: { line: 2, character: 5 } });
  assert.equal(hit.targetUri, 'file:///repo/note.yml');
  const whole = rangeOf(note, 'local.db');
  assert.deepEqual(hit.originSelectionRange, whole);
  const links = connection.handlers.links({ textDocument: { uri: 'file:///repo/note.yml' } });
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].range, whole);
  assert.match(links[0].target, /^file:\/\/\/repo\/note\.yml#/);
  await connection.handlers['yaml-dsl/active']({ path: '/repo/app/mock.yml' });
  connection.handlers['yaml-dsl/visibleFolds']({ stackIds: ['/repo/app/mock.yml'] });
  assert.equal(await connection.handlers['yaml-dsl/fold']({ stackId: '/repo/app/mock.yml', env: 'one' }), '');
  const folds = await connection.handlers['yaml-dsl/foldsFor']({ path: '/repo/app/mock.yml' });
  assert.equal(folds.stackId, null);
  documents.handlers.close({ document: { uri: 'file:///repo/app/mock.yml' } });
  assert.deepEqual(connection.diagnostics.at(-1).diagnostics, []);
  await documents.handlers.open({ document: { uri: 'yaml-dsl-fold:%2Frepo%2Fapp%2Fmock.yml/one', getText: () => 'name: plain\n' } });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../lib/bind');

function fakeConnection() {
  const handlers = {};
  const connection = {
    handlers,
    diagnostics: [],
    notifications: [],
    onInitialize(fn) { handlers.initialize = fn; },
    onHover(fn) { handlers.hover = fn; },
    onDefinition(fn) { handlers.definition = fn; },
    onDocumentLinks(fn) { handlers.links = fn; },
    onNotification(method, fn) { handlers[method] = fn; },
    onRequest(method, fn) { handlers[method] = fn; },
    onDidChangeWatchedFiles(fn) { handlers.watchedFiles = fn; },
    registrations: [],
    client: {
      register(type, options) {
        const registration = { method: type.method, options, disposed: false };
        connection.registrations.push(registration);
        return Promise.resolve({ dispose() { registration.disposed = true; } });
      },
    },
    sendDiagnostics(params) { this.diagnostics.push(params); },
    sendNotification(method, params) { this.notifications.push({ method, params }); },
  };
  return connection;
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
  const workspace = bind(connection, documents, {
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
  documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  documents.handlers.change({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  await workspace.whenIdle();
  const hover = await connection.handlers.hover({ textDocument: { uri: 'file:///repo/app/mock.yml' }, position: { line: 1, character: 0 } });
  assert.equal(hover.contents.value, 'the name');
  const missing = await connection.handlers.definition({ textDocument: { uri: 'file:///repo/app/mock.yml' }, position: { line: 1, character: 0 } });
  assert.equal(missing, null);
  await connection.handlers['yaml-dsl/config']({
    text: 'dsls:\n  - id: note\n    match: ["**/note.yml"]\n    symbols:\n      - kind: local\n        at: "$.locals.*"\n    references:\n      - pattern: "^local"\n        where: whole\n        target: { kind: local }\n',
    dir: '/repo',
  });
  const note = 'locals:\n  db: mock-value\nuse: local.db\n';
  documents.handlers.open({ document: { uri: 'file:///repo/note.yml', getText: () => note } });
  await workspace.whenIdle();
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
  connection.handlers['yaml-dsl/warm']({ paths: ['/repo/note.yml'] });
  await workspace.whenIdle();
  documents.handlers.close({ document: { uri: 'file:///repo/app/mock.yml' } });
  assert.deepEqual(connection.diagnostics.at(-1).diagnostics, []);
  await documents.handlers.open({ document: { uri: 'yaml-dsl-fold:%2Frepo%2Fapp%2Fmock.yml/one', getText: () => 'name: plain\n' } });
});

test('the server watches each schema path it reads and reloads a schema that changes', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const files = {};
  const workspace = bind(connection, documents, {
    readFile: async (filePath) => files[filePath] ?? null,
    fetchText: async () => null,
  });
  connection.handlers.initialize({
    capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } } },
  });
  await connection.handlers['yaml-dsl/config']({
    entries: [{ text: 'dsls:\n  - id: resources\n    match: ["**/mock.yml"]\n', dir: '/repo' }],
  });
  const text = '# yaml-language-server: $schema=.schema/mock.schema.json\nname: plain\n';
  documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  await workspace.whenIdle();
  const unavailable = () => connection.diagnostics
    .filter((item) => item.uri === 'file:///repo/app/mock.yml')
    .at(-1).diagnostics.some((item) => item.message === 'schema is unavailable');
  assert.equal(unavailable(), true);
  assert.equal(connection.registrations.length, 1);
  assert.equal(connection.registrations[0].method, 'workspace/didChangeWatchedFiles');
  assert.deepEqual(connection.registrations[0].options.watchers, [
    { globPattern: { baseUri: 'file:///repo/app', pattern: '.schema' } },
    { globPattern: { baseUri: 'file:///repo/app', pattern: '.schema/mock.schema.json' } },
  ]);

  files['/repo/app/.schema/mock.schema.json'] = '{"properties":{"name":{"description":"the name"}}}';
  connection.handlers.watchedFiles({ changes: [{ uri: 'file:///repo/app/.schema/mock.schema.json', type: 1 }] });
  await workspace.whenIdle();
  assert.equal(unavailable(), false);
  connection.handlers['yaml-dsl/visibleFolds']({ stackIds: [] });
  connection.handlers.watchedFiles({});
  await workspace.whenIdle();
  assert.equal(connection.registrations.length, 1);

  const moved = '# yaml-language-server: $schema=../schema.json\nname: plain\n';
  documents.handlers.change({ document: { uri: 'file:///repo/app/mock.yml', getText: () => moved } });
  await workspace.whenIdle();
  assert.equal(connection.registrations.length, 2);
  assert.deepEqual(connection.registrations[1].options.watchers, [
    { globPattern: { baseUri: 'file:///repo', pattern: 'schema.json' } },
  ]);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(connection.registrations[0].disposed, true);
  assert.equal(connection.registrations[1].disposed, false);
});

test('a client without relative-pattern watching gets no registration', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const workspace = bind(connection, documents, { readFile: async () => null, fetchText: async () => null });
  connection.handlers.initialize({ capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } });
  await connection.handlers['yaml-dsl/config']({
    entries: [{ text: 'dsls:\n  - id: resources\n    match: ["**/mock.yml"]\n', dir: '/repo' }],
  });
  documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => 'name: plain\n' } });
  await workspace.whenIdle();
  assert.equal(connection.registrations.length, 0);
});

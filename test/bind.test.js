const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../lib/bind');
const {
  scope,
  declaration,
  reference,
  placeholder,
  dslEntry,
  configText,
} = require('./config-builders');

const resourcesConfig = configText(dslEntry('resources'));

function fakeConnection() {
  const handlers = {};
  const connection = {
    handlers,
    notifications: [],
    onInitialize(fn) { handlers.initialize = fn; },
    onHover(fn) { handlers.hover = fn; },
    onDefinition(fn) { handlers.definition = fn; },
    onDocumentLinks(fn) { handlers.links = fn; },
    onCompletion(fn) { handlers.completion = fn; },
    tokenRefreshes: 0,
    languages: {
      semanticTokens: {
        on(fn) { handlers.semanticTokens = fn; },
        refresh() { connection.tokenRefreshes += 1; },
      },
    },
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
  const listeners = {};
  const fire = (name, event) => (listeners[name] ? listeners[name](event) : undefined);
  return {
    handlers: {
      open: (event) => Promise.all([fire('open', event), fire('change', event)]),
      change: (event) => fire('change', event),
      close: (event) => fire('close', event),
    },
    onDidOpen(fn) { listeners.open = fn; },
    onDidChangeContent(fn) { listeners.change = fn; },
    onDidClose(fn) { listeners.close = fn; },
  };
}

test('a link carries its target count', async () => {
  const connection = fakeConnection();
  const linkRange = { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } };
  const targetRange = { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } };
  const workspace = {
    whenAnalyzed: async () => {},
    onSuggestions() {},
    onVocabularyLoaded() {},
    links: () => [
      {
        range: linkRange,
        targets: [
          { path: '/repo/two/mock.yml', targetRange },
          { path: '/repo/three/mock.yml', targetRange },
        ],
      },
    ],
  };
  bind(connection, fakeDocuments(), { workspace });
  const links = await connection.handlers.links({ textDocument: { uri: 'file:///repo/mock.yml' } });
  assert.deepEqual(links, [{ range: linkRange, data: { targetCount: 2 } }]);
});

test('the default workspace still answers initialize', () => {
  const connection = fakeConnection();
  bind(connection, fakeDocuments());
  const result = connection.handlers.initialize();
  assert.equal(result.capabilities.hoverProvider, true);
  assert.equal(result.capabilities.definitionProvider, true);
  assert.equal(result.capabilities.documentLinkProvider.resolveProvider, false);
});

test('document events analyze and custom requests answer', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const files = { '/repo/schema.json': '{"description":"root","properties":{"name":{"description":"the name"}}}' };
  const workspace = bind(connection, documents, {
    readFile: async (filePath) => files[filePath] ?? null,
    fetchText: async () => null,
  });
  await connection.handlers['yaml-dsl/config']({
    entries: [{
      text: configText(dslEntry('resources', { schema_search_paths: ['schema.json'] })),
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
    text: configText(dslEntry('note', {
      file_includes: ['**/note.yml'],
      scopes: { local: scope() },
      declarations: [declaration('$.locals.*', 'local')],
      references: [reference('^local\\.(?<name>[a-z]+)$', 'local')],
    })),
    dir: '/repo',
  });
  const note = 'locals:\n  db: mock-value\nuse: local.db\n';
  documents.handlers.open({ document: { uri: 'file:///repo/note.yml', getText: () => note } });
  await workspace.whenIdle();
  const hit = await connection.handlers.definition({ textDocument: { uri: 'file:///repo/note.yml' }, position: { line: 2, character: 5 } });
  assert.equal(hit.targetUri, 'file:///repo/note.yml');
  const whole = rangeOf(note, 'local.db');
  assert.deepEqual(hit.originSelectionRange, whole);
  assert.deepEqual(await connection.handlers.links({ textDocument: { uri: 'file:///repo/note.yml' } }), []);
  await connection.handlers['yaml-dsl/active']({ path: '/repo/app/mock.yml' });
  connection.handlers['yaml-dsl/visibleFolds']({ stackIds: ['/repo/app/mock.yml'] });
  connection.handlers['yaml-dsl/cacheCapacities']({ stackCapacity: 4, schemaCapacity: 4 });
  assert.throws(() => connection.handlers['yaml-dsl/cacheCapacities']({ stackCapacity: 0, schemaCapacity: 4 }));
  assert.equal(await connection.handlers['yaml-dsl/fold']({ stackId: '/repo/app/mock.yml', overlayName: 'one' }), '');
  const noteDecorations = await connection.handlers['yaml-dsl/decorations']({ uri: 'file:///repo/note.yml' });
  assert.deepEqual(noteDecorations.references.map((item) => item.kind), ['local']);
  assert.deepEqual(noteDecorations.problems, [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    message: 'schema is unavailable',
    severity: 'info',
  }]);
  const folds = await connection.handlers['yaml-dsl/foldsFor']({ path: '/repo/app/mock.yml' });
  assert.equal(folds.stackId, null);
  await workspace.whenIdle();
  documents.handlers.close({ document: { uri: 'file:///repo/app/mock.yml' } });
  assert.deepEqual((await connection.handlers['yaml-dsl/decorations']({ uri: 'file:///repo/app/mock.yml' })).problems, []);
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
    entries: [{ text: resourcesConfig, dir: '/repo' }],
  });
  const text = '# yaml-language-server: $schema=.schema/mock.schema.json\nname: plain\n';
  documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  await workspace.whenIdle();
  const unavailable = async () => (await connection.handlers['yaml-dsl/decorations']({ uri: 'file:///repo/app/mock.yml' }))
    .problems.some((item) => item.message === 'schema is unavailable');
  assert.equal(await unavailable(), true);
  const watchedPatterns = (registrations) => registrations
    .flatMap((registration) => registration.options.watchers)
    .map((watcher) => `${watcher.globPattern.baseUri} ${watcher.globPattern.pattern}`);
  assert.ok(connection.registrations.every((registration) => registration.method === 'workspace/didChangeWatchedFiles'));
  assert.deepEqual(watchedPatterns(connection.registrations).filter((watched) => watched.includes('.schema')), [
    'file:///repo/app .schema',
    'file:///repo/app .schema/mock.schema.json',
  ]);

  files['/repo/app/.schema/mock.schema.json'] = '{"properties":{"name":{"description":"the name"}}}';
  connection.handlers.watchedFiles({ changes: [{ uri: 'file:///repo/app/.schema/mock.schema.json', type: 1 }] });
  await workspace.whenIdle();
  assert.equal(await unavailable(), false);
  const registeredBefore = connection.registrations.length;
  connection.handlers['yaml-dsl/visibleFolds']({ stackIds: [] });
  connection.handlers.watchedFiles({});
  await workspace.whenIdle();
  assert.equal(connection.registrations.length, registeredBefore);

  const moved = '# yaml-language-server: $schema=../schema.json\nname: plain\n';
  documents.handlers.change({ document: { uri: 'file:///repo/app/mock.yml', getText: () => moved } });
  await workspace.whenIdle();
  assert.deepEqual(watchedPatterns(connection.registrations.slice(registeredBefore)), ['file:///repo schema.json']);
  await new Promise((resolve) => { setImmediate(resolve); });
  const live = connection.registrations.filter((registration) => !registration.disposed);
  assert.ok(watchedPatterns(live).includes('file:///repo schema.json'));
  assert.equal(watchedPatterns(live).some((watched) => watched.includes('.schema')), false);
});

test('a client without relative-pattern watching gets no registration', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const workspace = bind(connection, documents, { readFile: async () => null, fetchText: async () => null });
  connection.handlers.initialize({ capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } });
  await connection.handlers['yaml-dsl/config']({
    entries: [{ text: resourcesConfig, dir: '/repo' }],
  });
  documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => 'name: plain\n' } });
  await workspace.whenIdle();
  assert.equal(connection.registrations.length, 0);
});

test('an analysis that changes a stack tells the client which documents to repaint', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const workspace = bind(connection, documents, { readFile: async () => null, fetchText: async () => null });
  await connection.handlers['yaml-dsl/config']({
    entries: [{ text: resourcesConfig, dir: '/repo' }],
  });
  const text = 'name: plain\n';
  documents.handlers.open({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  await workspace.whenIdle();
  const repaints = () => connection.notifications.filter((item) => item.method === 'yaml-dsl/reanalyzed');
  assert.deepEqual(repaints().at(-1).params.uris, ['file:///repo/app/mock.yml']);
  assert.ok(connection.tokenRefreshes >= 2);
  const repaintCount = repaints().length;
  documents.handlers.change({ document: { uri: 'file:///repo/app/mock.yml', getText: () => text } });
  await workspace.whenIdle();
  assert.equal(repaints().length, repaintCount);
});

test('completion answers editor items that replace what was typed', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const workspace = bind(connection, documents, { readFile: async () => null, fetchText: async () => null });
  const config = configText(dslEntry('note', {
    file_includes: ['**/note.yml'],
    scopes: { local: scope(), RESOURCE: scope({ named_by_parent_key: true }) },
    declarations: [
      declaration('$.locals.*', 'local'),
      declaration('$.*.*', 'RESOURCE', { skip_keys: ['locals'] }),
    ],
    references: [
      reference('^local\\.(?<name>[a-z]+)$', 'local'),
      reference('^ref (?<type>[a-z]+)\\.(?<name>[a-z]+)', 'RESOURCE', {
        text_after_name_allowed: true,
        scope_group: 'type',
      }),
    ],
  }));
  await connection.handlers['yaml-dsl/config']({ entries: [{ text: config, dir: '/repo' }] });
  const note = 'locals:\n  db: mock-value\nthing:\n  one:\n    use: local.\n    link: ref \n';
  documents.handlers.open({ document: { uri: 'file:///repo/note.yml', getText: () => note } });
  await workspace.whenIdle();
  const complete = (line, character) => connection.handlers.completion({
    textDocument: { uri: 'file:///repo/note.yml' },
    position: { line, character },
  });
  const [local] = await complete(4, 15);
  assert.equal(local.label, 'local.db');
  assert.equal(local.kind, 6);
  assert.equal(local.filterText, 'local.db');
  assert.deepEqual(local.textEdit, {
    range: { start: { line: 4, character: 9 }, end: { line: 4, character: 15 } },
    newText: 'local.db',
  });
  assert.deepEqual(local.documentation, { kind: 'markdown', value: '```yaml-dsl\n  db: mock-value\n```' });
  const [resource] = await complete(5, 14);
  assert.equal(resource.label, 'ref thing.one');
  assert.equal(resource.kind, 18);
  assert.equal(connection.handlers.initialize().capabilities.completionProvider.triggerCharacters.join(''), ' .{');
  const bare = bind(fakeConnection(), fakeDocuments(), { readFile: async () => null, fetchText: async () => null });
  assert.deepEqual(bare.completion('file:///repo/none.yml', { line: 0, character: 0 }), []);
});

test('semantic tokens are encoded with the legend, and a config change asks the editor to refresh them', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const workspace = bind(connection, documents, { readFile: async () => null, fetchText: async () => null });
  const legend = connection.handlers.initialize().capabilities.semanticTokensProvider.legend;
  assert.deepEqual(legend, {
    tokenTypes: ['function', 'keyword', 'operator', 'type', 'variable'],
    tokenModifiers: ['defaultLibrary'],
  });
  const config = configText(dslEntry('note', {
    file_includes: ['**/note.yml'],
    placeholder: placeholder(),
    scopes: { GLOBAL: scope({ builtin_names: ['env'] }) },
    references: [reference('^(?<name>[a-z0-9_]+)$', 'GLOBAL', { positions: ['whole_placeholder', 'placeholder_in_text'] })],
  }));
  await connection.handlers['yaml-dsl/config']({ entries: [{ text: config, dir: '/repo' }] });
  assert.equal(connection.tokenRefreshes, 1);
  documents.handlers.open({ document: { uri: 'file:///repo/note.yml', getText: () => 'a: ${env}\n' } });
  await workspace.whenIdle();
  const encoded = await connection.handlers.semanticTokens({ textDocument: { uri: 'file:///repo/note.yml' } });
  assert.deepEqual(encoded.data, [0, 3, 2, 2, 0, 0, 2, 3, 4, 1, 0, 3, 1, 2, 0]);
  const completed = await connection.handlers.completion({ textDocument: { uri: 'file:///repo/note.yml' }, position: { line: 0, character: 5 } });
  assert.equal(completed[0].kind, 21);
});

test('suggestions are sent as they arrive, and one is applied through the editor', async () => {
  const connection = fakeConnection();
  const applied = [];
  connection.workspace = {
    async applyEdit(edit) {
      applied.push(edit);
      return edit.changes['file:///refused.yml'] ? { applied: false } : { applied: true };
    },
  };
  let announce = null;
  const workspace = {
    onVocabularyLoaded() {},
    onSuggestions(listener) { announce = listener; },
    suggestionMarks: (stackId) => ({ stackId, files: [{ uri: 'file:///repo/dev/mock.yml', marks: [] }] }),
    applySuggestion(stackId, suggestionId) {
      if (suggestionId === 'stale') return { problem: 'the suggestion no longer applies' };
      const uri = `file:///${suggestionId}.yml`;
      return {
        edit: { changes: { [uri]: [] } },
        files: [{ uri, textHashBefore: 'mock-before', textHashAfter: 'mock-after' }],
      };
    },
  };
  bind(connection, fakeDocuments(), { workspace });
  announce('/repo/mock.yml');
  assert.deepEqual(connection.notifications.at(-1), {
    method: 'yaml-dsl/suggestions',
    params: { stackId: '/repo/mock.yml', files: [{ uri: 'file:///repo/dev/mock.yml', marks: [] }] },
  });
  const apply = connection.handlers['yaml-dsl/applySuggestion'];
  assert.deepEqual(await apply({ stackId: '/repo/mock.yml', id: 'queue' }), {
    applied: true,
    message: null,
    files: [{ uri: 'file:///queue.yml', textHashBefore: 'mock-before', textHashAfter: 'mock-after' }],
  });
  assert.deepEqual(applied, [{ changes: { 'file:///queue.yml': [] } }]);
  assert.deepEqual(await apply({ stackId: '/repo/mock.yml', id: 'stale' }), {
    applied: false,
    message: 'the suggestion no longer applies',
  });
  assert.deepEqual(await apply({ stackId: '/repo/mock.yml', id: 'refused' }), {
    applied: false,
    message: 'the editor did not apply the edit',
  });
});

test('a layer file that changes on disk is watched and read again', async () => {
  const connection = fakeConnection();
  const changed = [];
  const workspace = {
    onVocabularyLoaded() {},
    onSuggestions() {},
    schemaWatchTargets: () => [{ base: '/repo/.schema', pattern: 'mock.json' }],
    layerWatchTargets: () => [{ base: '/repo/dev', pattern: 'mock.yml' }],
    schemasChanged: async (paths) => { changed.push(['schemas', paths]); },
    layersChanged: async (paths) => { changed.push(['layers', paths]); },
    takeEvicted: () => [],
    takeReanalyzedUris: () => [],
  };
  bind(connection, fakeDocuments(), { workspace });
  connection.handlers.initialize({
    capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } } },
  });
  connection.handlers.watchedFiles({ changes: [{ uri: 'file:///repo/dev/mock.yml' }] });
  await workspace.whenIdle();
  assert.deepEqual(changed, [['schemas', ['/repo/dev/mock.yml']], ['layers', ['/repo/dev/mock.yml']]]);
  const patterns = connection.registrations.flatMap((registration) => registration.options.watchers)
    .map((watcher) => watcher.globPattern.pattern);
  assert.deepEqual(patterns, ['mock.json', 'mock.yml']);
});

test('a file the editor opens is analyzed once, though the library reports the open as a change too', async () => {
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const synced = [];
  const workspace = {
    onVocabularyLoaded() {},
    onSuggestions() {},
    sync: async (uri) => { synced.push(uri); },
    takeEvicted: () => [],
    takeReanalyzedUris: () => [],
    schemaWatchTargets: () => [],
    layerWatchTargets: () => [],
  };
  bind(connection, documents, { workspace });
  await documents.handlers.open({ document: { uri: 'file:///repo/mock.yml', getText: () => 'name: mock\n' } });
  assert.deepEqual(synced, ['file:///repo/mock.yml']);
});

test('a layer no editor has open is watched while its stack is loaded, and a change to it is analyzed again', async () => {
  const layeredConfig = configText(dslEntry('resources', {
    layers: {
      overlay_folders: ['dev', 'staging'],
      common_layer_discovery: 'parent',
      duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
    },
  }));
  const files = {
    '/repo/app/mock.yml': 'shared: 1\n',
    '/repo/app/dev/mock.yml': 'size: 1\n',
    '/repo/app/staging/mock.yml': 'size: 2\n',
  };
  const connection = fakeConnection();
  const documents = fakeDocuments();
  const workspace = bind(connection, documents, {
    readFile: async (filePath) => files[filePath] ?? null,
    fetchText: async () => null,
  });
  connection.handlers.initialize({
    capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } } },
  });
  await connection.handlers['yaml-dsl/config']({ entries: [{ text: layeredConfig, dir: '/repo' }] });
  await documents.handlers.open({ document: { uri: 'file:///repo/app/dev/mock.yml', getText: () => files['/repo/app/dev/mock.yml'] } });
  await workspace.whenIdle();
  const live = () => connection.registrations.filter((registration) => !registration.disposed)
    .flatMap((registration) => registration.options.watchers)
    .map((watcher) => `${watcher.globPattern.baseUri} ${watcher.globPattern.pattern}`);
  assert.ok(live().includes('file:///repo/app/staging mock.yml'), JSON.stringify(live()));
  const foldOfStaging = () => connection.handlers['yaml-dsl/fold']({ stackId: '/repo/app/mock.yml', overlayName: 'staging' });
  assert.match(await foldOfStaging(), /size: 2/);
  files['/repo/app/staging/mock.yml'] = 'size: 3\n';
  connection.notifications.length = 0;
  connection.handlers.watchedFiles({ changes: [{ uri: 'file:///repo/app/staging/mock.yml', type: 2 }] });
  await workspace.whenIdle();
  assert.match(await foldOfStaging(), /size: 3/);
  assert.ok(connection.notifications.some((notification) => notification.method === 'yaml-dsl/reanalyzed'));
});

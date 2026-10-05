const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activateWith,
  parseFoldPath,
  foldUri,
  associationPatterns,
  closeEvicted,
} = require('../lib/client');

function disposable() {
  return { dispose() {} };
}

function fakeVscode(options = {}) {
  const listeners = {
    emitter: [],
    open: [],
    change: [],
    active: [],
    visible: [],
  };
  const watcher = {
    onDidChange(fn) { watcher.change = fn; return disposable(); },
    onDidCreate(fn) { watcher.create = fn; return disposable(); },
    onDidDelete(fn) { watcher.delete = fn; return disposable(); },
    dispose() {},
  };
  const provider = {};
  const vscode = {
    ConfigurationTarget: { Workspace: 2 },
    EventEmitter: class {
      constructor() { this.fire = (value) => { for (const fn of listeners.emitter) fn(value); }; }
      event(fn) { listeners.emitter.push(fn); return disposable(); }
      dispose() {}
    },
    Uri: {
      joinPath(base, part) {
        return { fsPath: `${base.fsPath}/${part}`, toString() { return `file://${base.fsPath}/${part}`; } };
      },
      from(parts) { return { scheme: parts.scheme, path: parts.path, fsPath: parts.path }; },
    },
    workspace: {
      workspaceFolders: options.folders === undefined ? [{ uri: { fsPath: '/repo' } }] : options.folders,
      textDocuments: options.documents || [],
      fs: {
        readFile: options.readFile || (async () => Buffer.from('dsls:\n  - id: resources\n    match: ["**/mock.yml"]\n')),
      },
      getConfiguration() {
        return {
          get() { return options.associations || {}; },
          update: async (key, value) => { vscode.updated = value; },
        };
      },
      registerTextDocumentContentProvider(scheme, value) {
        provider.scheme = scheme;
        provider.value = value;
        return disposable();
      },
      createFileSystemWatcher() { return watcher; },
      onDidOpenTextDocument(fn) { listeners.open.push(fn); return disposable(); },
      onDidChangeTextDocument(fn) { listeners.change.push(fn); return disposable(); },
    },
    window: {
      activeTextEditor: options.editor === undefined ? null : options.editor,
      visibleTextEditors: options.visible || [],
      tabGroups: options.tabGroups,
      onDidChangeActiveTextEditor(fn) { listeners.active.push(fn); return disposable(); },
      onDidChangeVisibleTextEditors(fn) { listeners.visible.push(fn); return disposable(); },
      showTextDocument: options.showTextDocument || (async (uri, opts) => { vscode.shown.push({ uri, opts }); }),
    },
    languages: {
      setTextDocumentLanguage: async (doc, language) => { doc.languageId = language; vscode.languagesSet.push(doc); },
    },
    shown: [],
    languagesSet: [],
    listeners,
    watcher,
    provider,
  };
  return vscode;
}

function fakeClient(behavior = {}) {
  const notes = {};
  const sent = [];
  return {
    notes,
    sent,
    start() {},
    stop() { this.stopped = true; },
    onNotification(method, fn) { notes[method] = fn; },
    async sendNotification(method, params) {
      sent.push({ method, params });
      if (behavior.throwOn === method) throw new Error('down');
    },
    async sendRequest(method, params) {
      sent.push({ method, params });
      if (behavior.throwRequest) throw new Error('down');
      if (method === 'yaml-dsl/foldsFor') return behavior.foldsFor || { stackId: null, environments: [] };
      if (method === 'yaml-dsl/fold') return 'folded';
      return null;
    },
  };
}

test('fold paths round-trip and reject a path that is not a fold', () => {
  assert.equal(parseFoldPath(null), null);
  assert.equal(parseFoldPath('mock.yml'), null);
  assert.equal(parseFoldPath('/only'), null);
  const uri = foldUri({ Uri: { from: (parts) => parts } }, '/repo/mock.yml', 'one');
  const parsed = parseFoldPath(uri.path);
  assert.equal(parsed.stackId, '/repo/mock.yml');
  assert.equal(parsed.env, 'one');
});

test('activation associates matching files and reveals the fold', async () => {
  const doc = { uri: { scheme: 'file', fsPath: '/repo/mock/mock.yml' }, languageId: 'yaml' };
  const plain = { uri: { scheme: 'file', fsPath: '/repo/notes.txt' }, languageId: 'yaml' };
  const other = { uri: { scheme: 'untitled' }, languageId: 'yaml' };
  const owned = { uri: { scheme: 'file', fsPath: '/repo/other.yml' }, languageId: 'yaml-dsl' };
  const editor = { document: { uri: { scheme: 'file', fsPath: '/repo/mock/mock.yml', toString() { return 'file:///repo/mock/mock.yml'; } }, languageId: 'yaml-dsl' } };
  const foldEditor = { document: { uri: { scheme: 'yaml-dsl-fold', path: `/${encodeURIComponent('/repo/mock/mock.yml')}/one` } } };
  const vscode = fakeVscode({
    documents: [doc, plain, other, owned],
    editor,
    visible: [foldEditor, { document: null }, { document: { uri: { scheme: 'file', path: '/repo/a.yml' } } }],
    associations: { '**/mock.yml': 'yaml-dsl' },
    showTextDocument: async () => { throw new Error('no editor'); },
  });
  const client = fakeClient({ foldsFor: { stackId: '/repo/mock/mock.yml', environments: ['one', 'two'] }, throwRequest: false });
  const context = { subscriptions: [] };
  let started = null;
  const handle = await activateWith(vscode, context, (ctx) => { started = ctx; return client; });
  assert.equal(started, context);
  assert.equal(doc.languageId, 'yaml-dsl');
  assert.equal(plain.languageId, 'yaml');
  assert.equal(vscode.updated['**/mock.yml'], 'yaml-dsl');
  assert.equal(vscode.updated['mock.yml'], 'yaml-dsl');
  assert.equal(client.sent.some((item) => item.method === 'yaml-dsl/config'), true);
  assert.equal(client.sent.some((item) => item.method === 'yaml-dsl/active' && item.params.path === '/repo/mock/mock.yml'), true);
  assert.deepEqual(client.sent.find((item) => item.method === 'yaml-dsl/visibleFolds').params.stackIds, ['/repo/mock/mock.yml']);
  assert.equal(await vscode.provider.value.provideTextDocumentContent({ path: '/nope' }), '');
  assert.equal(await vscode.provider.value.provideTextDocumentContent({ path: `/${encodeURIComponent('/repo/mock/mock.yml')}/one` }), 'folded');

  vscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/x' }, languageId: 'markdown' } };
  await vscode.listeners.active[0]();
  assert.equal(client.sent.at(-2).params.path, null);

  client.sendRequest = async () => { throw new Error('down'); };
  vscode.window.activeTextEditor = editor;
  await vscode.listeners.active[0]();

  const throwing = fakeClient({ throwOn: 'yaml-dsl/active' });
  const quiet = fakeVscode({ editor, documents: [] });
  await activateWith(quiet, { subscriptions: [] }, () => throwing);
  const configThrow = fakeClient({ throwOn: 'yaml-dsl/config' });
  await activateWith(fakeVscode({ documents: [] }), { subscriptions: [] }, () => configThrow);


  vscode.listeners.change[0]({ document: { languageId: 'yaml-dsl', uri: { scheme: 'file' } } });
  vscode.listeners.change[0]({ document: { languageId: 'yaml', uri: { scheme: 'file' } } });
  await vscode.listeners.open[0]();
  await vscode.listeners.visible[0]();
  await vscode.watcher.change();
  await vscode.watcher.create();
  await vscode.watcher.delete();
  context.subscriptions[0].dispose();
  assert.equal(client.stopped, true);
  await handle.reloadConfig();
});

test('evicted folds close and a workspace without config still starts', async () => {
  const closed = [];
  const tabGroups = {
    all: [{
      tabs: [
        { input: { uri: { scheme: 'yaml-dsl-fold', path: `/${encodeURIComponent('/repo/mock.yml')}/one` } } },
        { input: { uri: { scheme: 'file', path: '/repo/a.yml' } } },
        { input: null },
        { input: { uri: { scheme: 'yaml-dsl-fold', path: '/only' } } },
      ],
    }],
    close: async (tabs) => { closed.push(tabs); },
  };
  const vscode = fakeVscode({
    folders: [{ uri: { fsPath: '/empty' } }],
    documents: [],
    editor: { document: { uri: { scheme: 'yaml-dsl-fold', path: '/fold', fsPath: '/fold' }, languageId: 'yaml-dsl' } },
    tabGroups,
    readFile: async () => { throw new Error('missing'); },
  });
  const client = fakeClient();
  await activateWith(vscode, { subscriptions: [] }, () => client);
  await client.notes['yaml-dsl/evicted']({ stackIds: ['/repo/mock.yml'] });
  assert.equal(closed.length, 1);
  await client.notes['yaml-dsl/evicted']({ stackIds: ['/other'] });
  assert.equal(closed.length, 1);
  await closeEvicted({ window: {} }, ['/repo/mock.yml']);
  const changed = fakeVscode({
    documents: [{ uri: { scheme: 'file', fsPath: '/repo/mock.yml' }, languageId: 'yaml' }],
    associations: {},
  });
  await activateWith(changed, { subscriptions: [] }, () => fakeClient());
  assert.equal(changed.updated['**/mock.yml'], 'yaml-dsl');
  assert.equal(changed.updated['mock.yml'], 'yaml-dsl');
  assert.deepEqual(associationPatterns(['**/mock.yml', '*.yml']), ['**/mock.yml', 'mock.yml', '*.yml']);
});

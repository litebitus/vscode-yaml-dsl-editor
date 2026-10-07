const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activateWith,
  parseFoldPath,
  foldUri,
  associationPatterns,
  closeEvicted,
  editorMiddleware,
  ownedFile,
  paintUnderlines,
} = require('../lib/client');
const {
  scope,
  reference,
  placeholder,
  dslEntry,
  configText,
} = require('./config-builders');

const sampleConfig = configText(dslEntry('sample'));

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
    ViewColumn: { Beside: 2 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
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
      parse(value) { return { scheme: 'file', toString() { return value; } }; },
    },
    workspace: {
      workspaceFolders: options.folders === undefined ? [{ uri: { fsPath: '/repo' } }] : options.folders,
      textDocuments: options.documents || [],
      fs: {
        readFile: options.readFile || (async () => Buffer.from(configText(dslEntry('resources')))),
      },
      openTextDocument: options.openTextDocument,
      getConfiguration() {
        return {
          get(key) {
            if (key && key.startsWith('cache.')) return options.cacheCapacity === undefined ? 32 : options.cacheCapacity;
            return options.associations || {};
          },
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
      createTextEditorDecorationType(options) {
        const decoration = { options };
        vscode.decorations.push(decoration);
        return { dispose() {} };
      },
    },
    commands: options.commands || {
      executeCommand: async (...args) => { vscode.peeked.push(args); },
      registerCommand(name, fn) {
        vscode.commandsByName[name] = fn;
        return disposable();
      },
    },
    languages: {
      setTextDocumentLanguage: async (doc, language) => { doc.languageId = language; vscode.languagesSet.push(doc); },
    },
    shown: [],
    peeked: [],
    decorations: [],
    commandsByName: {},
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
      if (method === 'yaml-dsl/foldsFor') return behavior.foldsFor || { stackId: null, overlayNames: [] };
      if (method === 'yaml-dsl/fold') return 'folded';
      if (method === 'yaml-dsl/decorations') return behavior.decorations === undefined ? null : behavior.decorations;
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
  assert.equal(parsed.overlayName, 'one');
});

test('a search that fails does not block activation', async () => {
  const vscode = fakeVscode({
    readFile: async () => Buffer.from('dsls: [\n'),
  });
  vscode.RelativePattern = class { constructor() {} };
  vscode.workspace.findFiles = async () => [];
  const client = fakeClient();
  await activateWith(vscode, { subscriptions: [] }, () => client);
  vscode.workspace.fs.readFile = async () => Buffer.from(sampleConfig);
  vscode.workspace.findFiles = async () => { throw new Error('down'); };
  await vscode.watcher.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.sent.some((item) => item.method === 'yaml-dsl/warm'), false);
});

test('activation asks the server to read matching files', async () => {
  const vscode = fakeVscode({
    readFile: async () => Buffer.from(configText(dslEntry('sample', { file_includes: ['**/mock.yml', '**/mock.yml'] }))),
  });
  vscode.RelativePattern = class {
    constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; }
  };
  const seen = [];
  vscode.workspace.findFiles = async (include) => {
    seen.push(include.pattern);
    return [{ fsPath: '/repo/mock.yml' }, { fsPath: '/repo/mock.yml' }, {}, null];
  };
  const client = fakeClient();
  await activateWith(vscode, { subscriptions: [] }, () => client);
  await new Promise((resolve) => setImmediate(resolve));
  const warm = client.sent.find((item) => item.method === 'yaml-dsl/warm');
  assert.deepEqual(warm.params.paths, ['/repo/mock.yml']);
  assert.deepEqual(seen, ['**/mock.yml', '**/mock.yml']);
});

test('a workspace folder added or removed reloads the configs', async () => {
  const vscode = fakeVscode();
  let foldersChanged = null;
  vscode.workspace.onDidChangeWorkspaceFolders = (fn) => {
    foldersChanged = fn;
    return disposable();
  };
  const client = fakeClient();
  await activateWith(vscode, { subscriptions: [] }, () => client);
  const configsSent = () => client.sent.filter((item) => item.method === 'yaml-dsl/config').length;
  const before = configsSent();
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/repo' } }, { uri: { fsPath: '/second' } }];
  foldersChanged();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configsSent(), before + 1);
  assert.deepEqual(client.sent.filter((item) => item.method === 'yaml-dsl/config').at(-1).params.entries
    .map((entry) => entry.dir), ['/repo', '/second']);
});

test('activation associates matching files and reveals the fold', async () => {
  const doc = { uri: { scheme: 'file', fsPath: '/repo/mock/mock.yml' }, languageId: 'yaml' };
  const outside = { uri: { scheme: 'file', fsPath: '/other/mock.yml' }, languageId: 'yaml-dsl' };
  const plain = { uri: { scheme: 'file', fsPath: '/repo/notes.txt' }, languageId: 'yaml' };
  const other = { uri: { scheme: 'untitled' }, languageId: 'yaml' };
  const owned = { uri: { scheme: 'file', fsPath: '/repo/other.yml' }, languageId: 'yaml-dsl' };
  const editor = { document: { uri: { scheme: 'file', fsPath: '/repo/mock/mock.yml', toString() { return 'file:///repo/mock/mock.yml'; } }, languageId: 'yaml-dsl' } };
  const foldEditor = { document: { uri: { scheme: 'yaml-dsl-fold', path: `/${encodeURIComponent('/repo/mock/mock.yml')}/one` } } };
  const vscode = fakeVscode({
    documents: [doc, plain, other, owned, outside],
    editor,
    visible: [foldEditor, { document: null }, { document: { uri: { scheme: 'file', path: '/repo/a.yml' } } }],
    associations: { '**/mock.yml': 'yaml-dsl' },
    openTextDocument: async (uri) => ({ uri, languageId: 'plaintext' }),
  });
  const client = fakeClient({ foldsFor: { stackId: '/repo/mock/mock.yml', overlayNames: ['one'] }, throwRequest: false });
  const context = { subscriptions: [] };
  let started = null;
  const handle = await activateWith(vscode, context, (ctx) => { started = ctx; return client; });
  assert.equal(started, context);
  assert.equal(doc.languageId, 'yaml-dsl');
  assert.equal(outside.languageId, 'yaml');
  assert.equal(plain.languageId, 'yaml');
  assert.deepEqual(vscode.updated, {});
  assert.equal(client.sent.some((item) => item.method === 'yaml-dsl/config'), true);
  assert.equal(client.sent.some((item) => item.method === 'yaml-dsl/active' && item.params.path === '/repo/mock/mock.yml'), true);
  assert.deepEqual(client.sent.find((item) => item.method === 'yaml-dsl/visibleFolds').params.stackIds, ['/repo/mock/mock.yml']);
  assert.equal(vscode.peeked.length, 0);
  assert.equal(vscode.languagesSet[0].languageId, 'yaml-dsl');
  await vscode.listeners.active[0]();
  assert.equal(vscode.peeked.length, 0);
  assert.equal(await vscode.provider.value.provideTextDocumentContent({ path: '/nope' }), '');
  assert.equal(await vscode.provider.value.provideTextDocumentContent({ path: `/${encodeURIComponent('/repo/mock/mock.yml')}/one` }), 'folded');

  vscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/x' }, languageId: 'markdown' } };
  await vscode.listeners.active[0]();
  assert.equal(client.sent.at(-2).params.path, null);

  client.sendRequest = async (method) => {
    if (method === 'yaml-dsl/foldsFor') return { stackId: '/repo/mock/mock.yml', overlayNames: ['one', 'two'] };
    return null;
  };
  vscode.window.activeTextEditor = editor;
  await vscode.listeners.active[0]();
  assert.equal(vscode.peeked.length, 0);

  editor.selection = { active: { line: 0, character: 0 } };
  await vscode.commandsByName['yaml-dsl-editor.peek']();
  await vscode.commandsByName['yaml-dsl-editor.peek']({
    uri: 'file:///repo/mock.yml',
    startLine: 1,
    startCharacter: 0,
    endLine: 1,
    endCharacter: 3,
  });
  assert.equal(vscode.peeked.at(-1)[0], 'editor.action.closeReferenceSearch');
  assert.equal(vscode.shown.at(-1).opts.preview, true);

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
  const foldDoc = { uri: { scheme: 'yaml-dsl-fold', path: '/repo/mock.yml/one' }, languageId: 'plaintext' };
  await vscode.listeners.open[0](foldDoc);
  assert.equal(foldDoc.languageId, 'yaml-dsl');
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
  const sample = { uri: { scheme: 'file', fsPath: '/repo/mock.yml' }, languageId: 'yaml' };
  const changed = fakeVscode({
    documents: [sample],
    associations: {},
  });
  await activateWith(changed, { subscriptions: [] }, () => fakeClient());
  assert.equal(sample.languageId, 'yaml-dsl');
  assert.equal(changed.updated, undefined);
  assert.equal(ownedFile('/other/mock.yml', [{ dir: '/repo', text: sampleConfig }]), false);
  assert.equal(ownedFile('/repo/mock.yml', [{ dir: '/repo', text: sampleConfig }]), true);
  assert.deepEqual(associationPatterns(['**/mock.yml', '*.yml']), ['**/mock.yml', 'mock.yml', '*.yml']);
});

test('a cross-file target peeks that section and leaves this file', async () => {
  const peeked = [];
  const vscode = {
    Position: class {
      constructor(line, character) { this.line = line; this.character = character; }
    },
    Range: class {
      constructor(a, b, c, d) {
        this.start = { line: a, character: b };
        this.end = { line: c, character: d };
      }
    },
    Location: class {
      constructor(uri, range) { this.uri = uri; this.range = range; }
    },
    Uri: {
      parse(value) {
        const hash = value.indexOf('#');
        const base = hash >= 0 ? value.slice(0, hash) : value;
        const fragment = hash >= 0 ? value.slice(hash + 1) : '';
        const scheme = base.startsWith('command:') ? 'command' : 'file';
        return {
          scheme,
          fragment,
          toString() { return base; },
          with() { return { scheme, fragment: '', toString() { return base; } }; },
        };
      },
    },
    commands: { executeCommand: async (...args) => { peeked.push(args); } },
  };
  const mid = editorMiddleware(vscode);
  const here = { scheme: 'file', toString() { return 'file:///repo/one/mock.yml'; } };
  const links = await mid.provideDocumentLinks({ uri: here }, null, async () => [
    { target: 'file:///repo/mock.yml#3,2,3,9' },
    { target: 'file:///repo/one/mock.yml#1,1,1,2' },
    {},
  ]);
  assert.equal(links[0].target, 'file:///repo/mock.yml#3,2,3,9');
  assert.equal(links[1].target, 'file:///repo/one/mock.yml#1,1,1,2');
  assert.equal(await mid.provideDocumentLinks({ uri: here }, null, async () => null), null);
  assert.equal(peeked.length, 0);

  let calls = 0;
  let cancel = null;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(fn) { cancel = fn; return { dispose() {} }; },
  };
  const hover = await mid.provideHover({ uri: here }, { line: 4, character: 2 }, token, async () => {
    calls += 1;
    return { contents: 'tip' };
  });
  assert.equal(hover.contents, 'tip');
  assert.equal(calls, 1);
  assert.equal(peeked.some((item) => item[0] === 'editor.action.peekLocations'), false);
  assert.equal(
    (await mid.provideHover({ uri: here }, { line: 0, character: 0 }, null, async () => ({ contents: 'plain' }))).contents,
    'plain',
  );
  vscode.MarkdownString = class {
    constructor() { this.value = ''; }
    appendMarkdown(text) { this.value += text; }
  };
  vscode.Hover = class {
    constructor(contents, range) { this.contents = contents; this.range = range; }
  };
  const section = await mid.provideHover({ uri: here }, { line: 0, character: 0 }, null, async () => ({
    contents: { value: '[mock.yml:3](file:///repo/mock.yml#L3)\n\n```yaml-dsl\n# note\nref x\n  data_at_rest_key: "a\\\\b" \'c\'\n\n  ref ${\n```' },
  }));
  assert.match(section.contents.value, /<div><a href="[^"]+"><code><u>mock\.yml:3<\/u><\/code><\/a><div>/);
  assert.match(section.contents.value, /data_at_rest_key/);
  assert.match(section.contents.value, /<br>/);
  assert.match(section.contents.value, /color:#87C3FF;/);
  assert.equal(section.contents.value.includes('```'), false);
  assert.equal(section.contents.value.includes('\n'), false);
  assert.match(section.contents.value, /command:yaml-dsl-editor\.peek\?/);
  assert.match(decodeURIComponent(section.contents.value), /"startLine":2/);
  assert.match(section.contents.value, /data_at_rest_key/);
  assert.equal(section.contents.isTrusted.enabledCommands[0], 'yaml-dsl-editor.peek');
  assert.equal(peeked.some((item) => item[0] === 'editor.action.peekLocations'), false);
  const bare = await mid.provideHover({ uri: here }, { line: 0, character: 0 }, null, async () => ({
    contents: { value: '[mock.yml:3](file:///repo/mock.yml#L3)' },
  }));
  assert.match(bare.contents.value, /<code><u>mock\.yml:3<\/u><\/code>/);
  assert.equal(bare.contents.value.includes('```'), false);

  peeked.length = 0;
  const moved = {
    isCancellationRequested: false,
    onCancellationRequested(fn) { cancel = fn; return { dispose() {} }; },
  };
  const pending = mid.provideHover({ uri: here }, { line: 1, character: 1 }, moved, async () => {
    calls += 1;
    return { contents: 'late' };
  });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  cancel();
  moved.isCancellationRequested = true;
  assert.equal(await pending, null);
  assert.equal(calls, 1);
  assert.equal(peeked.some((item) => item[0] === 'editor.action.peekLocations'), false);
});

function placeAt(text, offset) {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

function referenceMarks() {
  return {
    local: { kind: 'local' },
    external: { kind: 'external' },
    error: { kind: 'error' },
    unclassified: { kind: 'unclassified' },
  };
}

function rangeOf(line, from, to) {
  return { start: { line, character: from }, end: { line, character: to } };
}

function documentOf(text, name = 'mock.yml') {
  return {
    languageId: 'yaml-dsl',
    uri: { scheme: 'file', fsPath: `/repo/${name}`, toString() { return `file:///repo/${name}`; } },
    getText(range) {
      if (!range) return text;
      const lines = text.split('\n');
      if (range.start.line === range.end.line) {
        return (lines[range.start.line] || '').slice(range.start.character, range.end.character);
      }
      const first = lines[range.start.line].slice(range.start.character);
      const middle = lines.slice(range.start.line + 1, range.end.line);
      const last = lines[range.end.line].slice(0, range.end.character);
      return [first, ...middle, last].join('\n');
    },
  };
}

function recordingEditor(doc, painted) {
  return { document: doc, setDecorations(mark, ranges) { painted.push({ kind: mark.kind, ranges }); } };
}

function lastPaint(painted, kind) {
  return painted.filter((item) => item.kind === kind).at(-1);
}

const referenceScopes = { local: scope(), RESOURCE: scope({ named_by_parent_key: true }) };
const referenceRules = [
  reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_.${}]+)', 'RESOURCE', {
    text_after_name_allowed: true,
    scope_group: 'type',
  }),
  reference('^local\\.(?<name>[a-z_]+)$', 'local', {
    positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
  }),
];
const referenceDsl = (extraRules = []) => dslEntry('sample', {
  file_includes: ['**/*.yml'],
  placeholder: placeholder(),
  scopes: referenceScopes,
  references: [...referenceRules, ...extraRules],
});
const referenceConfig = configText(referenceDsl());

test('references are painted by the class the server gives them', async () => {
  const painted = [];
  const doc = documentOf('a: ref one.two\nb: ref three.four\nc: ref five.six\nd: x\n');
  const plainPainted = [];
  const plainEditor = recordingEditor({ languageId: 'yaml', uri: { scheme: 'file' } }, plainPainted);
  const vscode = { window: { visibleTextEditors: [recordingEditor(doc, painted), plainEditor, { document: null }] } };
  const client = fakeClient({
    decorations: {
      references: [
        { range: rangeOf(0, 3, 14), kind: 'local' },
        { range: rangeOf(1, 3, 17), kind: 'external' },
        { range: rangeOf(2, 3, 15), kind: 'error' },
        { range: rangeOf(3, 3, 4), kind: 'unknown' },
      ],
      problems: [],
    },
  });
  await paintUnderlines(vscode, client, referenceMarks(), [{ text: referenceConfig, dir: '/repo' }]);
  const covered = (kind) => lastPaint(painted, kind).ranges.map((mark) => doc.getText(mark.range || mark));
  assert.deepEqual(covered('local'), ['ref one.two']);
  assert.deepEqual(covered('external'), ['ref three.four']);
  assert.deepEqual(covered('error'), ['ref five.six']);
  assert.deepEqual(covered('unclassified'), []);
  assert.deepEqual(client.sent.at(-1), { method: 'yaml-dsl/decorations', params: { uri: 'file:///repo/mock.yml' } });
  assert.deepEqual(plainPainted.map((item) => item.ranges.length), [0, 0, 0, 0]);
});

test('a classified ref takes its class underline whole, placeholders inside it included', async () => {
  const text = 'ref redshift.\n${env}_cluster';
  const painted = [];
  const doc = documentOf(text);
  const vscode = { window: { visibleTextEditors: [recordingEditor(doc, painted)] } };
  const whole = { start: { line: 0, character: 0 }, end: { line: 1, character: 14 } };
  const client = fakeClient({ decorations: { references: [{ range: whole, kind: 'external' }], problems: [] } });
  await paintUnderlines(vscode, client, referenceMarks(), []);
  assert.deepEqual(lastPaint(painted, 'external').ranges, [whole]);
});

test('every ref is underlined from the text before the server classifies it, once per editor', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const text = [
    'integration_name ${local.ai_result}:',
    '  vpc_id: ref data_source.vpc.id',
    '  - ref iam_role.redshift.arn',
    '  label: local.db',
    '  note: not a ref',
    '  Resource: ["%s/*", [ref data_source.bucket.arn], ref data_source.key.arn]',
  ].join('\n');
  const painted = [];
  const doc = documentOf(text);
  const editor = recordingEditor(doc, painted);
  const vscode = { window: { visibleTextEditors: [editor] } };
  const client = fakeClient();
  client.sendRequest = async () => {
    await gate;
    return { references: [{ range: rangeOf(1, 10, 33), kind: 'external' }], problems: [] };
  };
  const entries = [
    { text: referenceConfig, dir: '/elsewhere' },
    { text: referenceConfig, dir: '/repo' },
  ];
  const pending = paintUnderlines(vscode, client, referenceMarks(), entries);
  const early = lastPaint(painted, 'unclassified').ranges.map((range) => doc.getText(range));
  assert.deepEqual(early.sort(), [
    'local.ai_result',
    'local.db',
    'ref data_source.bucket.arn',
    'ref data_source.key.arn',
    'ref data_source.vpc.id',
    'ref iam_role.redshift.arn',
  ]);
  release();
  await pending;
  assert.deepEqual(lastPaint(painted, 'unclassified').ranges, []);
  painted.length = 0;
  await paintUnderlines(vscode, client, referenceMarks(), entries);
  assert.equal(painted.some((item) => item.kind === 'unclassified' && item.ranges.length > 0), false);
});

test('a document the server has not analyzed keeps its text-pass underlines', async () => {
  const painted = [];
  const doc = documentOf('a: ref one.two\n', 'unanalyzed.yml');
  const vscode = { window: { visibleTextEditors: [recordingEditor(doc, painted)] } };
  await paintUnderlines(vscode, fakeClient(), referenceMarks(), [{ text: referenceConfig, dir: '/repo' }]);
  const failing = fakeClient({ throwRequest: true });
  await paintUnderlines(vscode, failing, referenceMarks(), [{ text: referenceConfig, dir: '/repo' }]);
  assert.equal(lastPaint(painted, 'unclassified').ranges.length, 1);
  assert.equal(painted.some((item) => item.kind === 'external'), true);
  assert.equal(lastPaint(painted, 'external').ranges.length, 0);
});

test('a reanalyzed notification repaints only the documents it names, and an edit paints nothing', async () => {
  const painted = [];
  const first = { ...recordingEditor(documentOf('name: plain\n', 'one.yml'), painted), name: 'one.yml' };
  const second = { ...recordingEditor(documentOf('name: plain\n', 'two.yml'), painted), name: 'two.yml' };
  first.setDecorations = () => { painted.push('one.yml'); };
  second.setDecorations = () => { painted.push('two.yml'); };
  const vscode = fakeVscode({ visible: [first, second] });
  const client = fakeClient({ decorations: { references: [{ range: rangeOf(0, 0, 4), kind: 'local' }], problems: [] } });
  await activateWith(vscode, { subscriptions: [] }, () => client);
  await new Promise((resolve) => setImmediate(resolve));
  painted.length = 0;
  vscode.listeners.change[0]({ document: first.document });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(painted, []);
  await client.notes['yaml-dsl/reanalyzed']({ uris: ['file:///repo/two.yml'] });
  assert.ok(painted.length > 0);
  assert.ok(painted.every((name) => name === 'two.yml'));
  painted.length = 0;
  await client.notes['yaml-dsl/reanalyzed']({});
  assert.deepEqual(painted, []);
});

test('classes that arrive after a newer paint are dropped', async () => {
  const painted = [];
  let releaseOlder;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  let requestCount = 0;
  const doc = documentOf('abc', 'stale.yml');
  const vscode = { window: { visibleTextEditors: [recordingEditor(doc, painted)] } };
  const client = fakeClient();
  client.sendRequest = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      await olderGate;
      return { references: [{ range: rangeOf(0, 0, 1), kind: 'local' }], problems: [] };
    }
    return { references: [{ range: rangeOf(0, 0, 2), kind: 'local' }], problems: [] };
  };
  const older = paintUnderlines(vscode, client, referenceMarks(), []);
  await paintUnderlines(vscode, client, referenceMarks(), []);
  releaseOlder();
  await older;
  const localPaints = painted.filter((item) => item.kind === 'local' && item.ranges.length > 0);
  assert.equal(localPaints.length, 1);
  assert.equal(localPaints[0].ranges[0].end.character, 2);
});

test('problems are error squiggles with their message on hover, a whole line when the range is empty', async () => {
  const painted = [];
  const doc = documentOf('# yaml-language-server: $schema=missing.json\nname: [\nsource: ref one.two\n');
  doc.lineCount = 4;
  doc.lineAt = (line) => ({ range: rangeOf(line, 0, doc.getText().split('\n')[line].length) });
  const vscode = { window: { visibleTextEditors: [recordingEditor(doc, painted)] } };
  const client = fakeClient({
    decorations: {
      references: null,
      problems: [
        { range: rangeOf(0, 0, 0), message: 'schema is unavailable' },
        { range: rangeOf(1, 6, 7), message: 'flow sequence is not closed' },
        { range: rangeOf(9, 0, 0), message: 'past the end' },
      ],
    },
  });
  await paintUnderlines(vscode, client, referenceMarks(), [{ text: referenceConfig, dir: '/repo' }]);
  assert.deepEqual(lastPaint(painted, 'error').ranges, [
    { range: rangeOf(0, 0, 44), hoverMessage: 'schema is unavailable' },
    { range: rangeOf(1, 6, 7), hoverMessage: 'flow sequence is not closed' },
    { range: rangeOf(9, 0, 0), hoverMessage: 'past the end' },
  ]);
  assert.equal(lastPaint(painted, 'unclassified').ranges.length, 1);
  assert.equal(painted.some((item) => item.kind === 'external' && item.ranges.length > 0), false);
});

test('a workspace config file shows its own problems and nothing else', async () => {
  const painted = [];
  const config = {
    languageId: 'yaml',
    uri: { scheme: 'file', fsPath: '/repo/yaml-dsl.yml', toString() { return 'file:///repo/yaml-dsl.yml'; } },
    getText: () => 'dsls: [\n',
  };
  const elsewhere = {
    languageId: 'yaml',
    uri: { scheme: 'file', fsPath: '/other/yaml-dsl.yml', toString() { return 'file:///other/yaml-dsl.yml'; } },
  };
  const otherPainted = [];
  const vscode = {
    window: { visibleTextEditors: [recordingEditor(config, painted), recordingEditor(elsewhere, otherPainted)] },
  };
  const client = fakeClient({ decorations: { references: null, problems: [{ range: rangeOf(0, 3, 4), message: 'bad config' }] } });
  await paintUnderlines(vscode, client, referenceMarks(), [{ text: 'dsls: [\n', dir: '/repo' }]);
  assert.deepEqual(lastPaint(painted, 'error').ranges, [{ range: rangeOf(0, 3, 4), hoverMessage: 'bad config' }]);
  assert.equal(painted.some((item) => item.kind === 'unclassified'), false);
  assert.deepEqual(client.sent.map((item) => item.params.uri), ['file:///repo/yaml-dsl.yml']);
  assert.ok(otherPainted.every((item) => item.ranges.length === 0));
});

test('a hover colors the declaration by the declaring file\'s DSL, with no DSL syntax of its own', async () => {
  const vscode = {
    MarkdownString: class {
      constructor() { this.value = ''; }
      appendMarkdown(text) { this.value += text; }
    },
    Hover: class {
      constructor(contents, range) { this.contents = contents; this.range = range; }
    },
  };
  const hover = (configText) => editorMiddleware(vscode, () => [{ text: configText, dir: '/repo' }])
    .provideHover({ uri: {} }, { line: 0, character: 0 }, null, async () => ({
      contents: {
        value: '[mock.yml:1](file:///repo/mock.yml#L1)\n\n```yaml-dsl\n'
          + '  source: ref thing.one\n  name: "x" ${local.db} ${env} @{y}\n```',
      },
    }));
  const configured = (await hover(referenceConfig)).contents.value;
  assert.match(configured, /<span style="color:#efb080;">ref<\/span>/);
  assert.match(configured, /<span style="color:#82D2CE;">\$\{local\.db\}<\/span>/);
  assert.match(configured, /<span style="color:#82D2CE;">\$\{env\}<\/span>/);
  assert.doesNotMatch(configured, /color:#82D2CE;">@\{y\}/);
  const other = configText(dslEntry('other', {
    file_includes: ['**/*.yml'],
    placeholder: placeholder({ pattern: '@\\{(?<body>[^}]*)\\}' }),
    scopes: { local: scope() },
    references: [reference('use (?<name>[a-z]+)', 'local', { positions: ['anywhere_in_scalar'] })],
  }));
  const otherDsl = (await hover(other)).contents.value;
  assert.doesNotMatch(otherDsl, /color:#efb080;">ref/);
  assert.doesNotMatch(otherDsl, /color:#82D2CE;">\$\{env\}/);
  assert.match(otherDsl, /<span style="color:#82D2CE;">@\{y\}<\/span>/);
  const unowned = (await editorMiddleware(vscode).provideHover({ uri: {} }, { line: 0, character: 0 }, null, async () => ({
    contents: { value: '[mock.yml:1](file:///repo/mock.yml#L1)\n\n```yaml-dsl\n  source: ref thing.one\n```' },
  }))).contents.value;
  assert.doesNotMatch(unowned, /color:#efb080/);
});

test('the text pass underlines placeholder references and within matches from the config', async () => {
  const painted = [];
  const doc = documentOf('a: "${local.db} ${env} ${bad}"\nb: use thing\n');
  const vscode = { window: { visibleTextEditors: [recordingEditor(doc, painted)] } };
  const withinConfig = configText(referenceDsl([
    reference('use (?<name>[a-z]+)', 'local', { positions: ['anywhere_in_scalar'] }),
  ]));
  await paintUnderlines(vscode, fakeClient(), referenceMarks(), [{ text: withinConfig, dir: '/repo' }]);
  const covered = lastPaint(painted, 'unclassified').ranges.map((range) => doc.getText(range));
  assert.deepEqual(covered.sort(), ['local.db', 'use thing']);
  const unowned = [];
  await paintUnderlines(
    { window: { visibleTextEditors: [recordingEditor(documentOf('a: ref x.y\n', 'elsewhere.txt'), unowned)] } },
    fakeClient(),
    referenceMarks(),
    [{ text: referenceConfig, dir: '/other' }],
  );
  assert.deepEqual(lastPaint(unowned, 'unclassified').ranges, []);
});

test('activation leaves excluded files out of the warm-up', async () => {
  const vscode = fakeVscode({
    readFile: async () => Buffer.from(configText(dslEntry('suites', {
      file_includes: ['**/*.yml'],
      file_excludes: ['**/protocols/**'],
    }))),
  });
  vscode.RelativePattern = class { constructor(folder, pattern) { this.pattern = pattern; } };
  vscode.workspace.findFiles = async () => [{ fsPath: '/repo/games/slot.yml' }, { fsPath: '/repo/protocols/mock/protocol.yml' }];
  const client = fakeClient();
  await activateWith(vscode, { subscriptions: [] }, () => client);
  await new Promise((resolve) => setImmediate(resolve));
  const warm = client.sent.find((item) => item.method === 'yaml-dsl/warm');
  assert.deepEqual(warm.params.paths, ['/repo/games/slot.yml']);
});

test('the repaint notice is handled from the moment the client starts, before activation finishes', async () => {
  const painted = [];
  const editor = {
    document: { languageId: 'yaml-dsl', uri: { scheme: 'file', fsPath: '/repo/mock.yml', toString() { return 'file:///repo/mock.yml'; } }, getText: () => '' },
    setDecorations(mark, ranges) { painted.push(ranges.length); },
  };
  const vscode = fakeVscode({ visible: [editor] });
  let answer = null;
  let release;
  const client = fakeClient();
  client.sendRequest = async (method) => {
    if (method !== 'yaml-dsl/decorations') return null;
    if (!release) await new Promise((resolve) => { release = resolve; });
    return answer;
  };
  const activation = activateWith(vscode, { subscriptions: [] }, () => client);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof client.notes['yaml-dsl/reanalyzed'], 'function');
  answer = { references: [{ range: rangeOf(0, 0, 3), kind: 'external' }], problems: [] };
  await client.notes['yaml-dsl/reanalyzed']({ uris: ['file:///repo/mock.yml'] });
  release();
  await activation;
  assert.ok(painted.some((count) => count === 1));
});

test('a hover reads # as a comment only at a line start or after whitespace', async () => {
  const vscode = {
    MarkdownString: class {
      constructor() { this.value = ''; }
      appendMarkdown(text) { this.value += text; }
    },
    Hover: class {
      constructor(contents, range) { this.contents = contents; this.range = range; }
    },
  };
  const hover = await editorMiddleware(vscode).provideHover({ uri: {} }, { line: 0, character: 0 }, null, async () => ({
    contents: {
      value: '[mock.yml:1](file:///repo/mock.yml#L1)\n\n```yaml-dsl\n'
        + '# whole line\n  messages: ../mock/protocol.yml#mock  # trailing\n```',
    },
  }));
  const body = hover.contents.value;
  assert.match(body, /<span style="color:#6A9955;"># whole line<\/span>/);
  assert.match(body, /protocol\.yml#mock/);
  assert.doesNotMatch(body, /color:#6A9955;">#mock/);
  assert.match(body, /<span style="color:#6A9955;"># trailing<\/span>/);
});

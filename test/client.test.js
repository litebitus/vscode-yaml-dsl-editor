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
        readFile: options.readFile || (async () => Buffer.from('dsls:\n  - id: resources\n    match: ["**/mock.yml"]\n')),
      },
      openTextDocument: options.openTextDocument,
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

test('a search that fails does not block activation', async () => {
  const vscode = fakeVscode({
    readFile: async () => Buffer.from('dsls: [\n'),
  });
  vscode.RelativePattern = class { constructor() {} };
  vscode.workspace.findFiles = async () => [];
  const client = fakeClient();
  await activateWith(vscode, { subscriptions: [] }, () => client);
  vscode.workspace.fs.readFile = async () => Buffer.from('dsls:\n  - id: sample\n    match: ["**/mock.yml"]\n');
  vscode.workspace.findFiles = async () => { throw new Error('down'); };
  await vscode.watcher.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.sent.some((item) => item.method === 'yaml-dsl/warm'), false);
});

test('activation asks the server to read matching files', async () => {
  const vscode = fakeVscode({
    readFile: async () => Buffer.from('dsls:\n  - id: sample\n    match: ["**/mock.yml", "**/mock.yml"]\n'),
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
  const client = fakeClient({ foldsFor: { stackId: '/repo/mock/mock.yml', environments: ['one'] }, throwRequest: false });
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
    if (method === 'yaml-dsl/foldsFor') return { stackId: '/repo/mock/mock.yml', environments: ['one', 'two'] };
    return null;
  };
  vscode.window.activeTextEditor = editor;
  await vscode.listeners.active[0]();
  assert.equal(vscode.peeked.length, 0);

  editor.selection = { active: { line: 0, character: 0 } };
  await vscode.commandsByName['yaml-dsl.peek']();
  await vscode.commandsByName['yaml-dsl.peek']({
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
  assert.equal(ownedFile('/other/mock.yml', [{ dir: '/repo', text: 'dsls:\n  - id: sample\n    match: ["**/mock.yml"]\n' }]), false);
  assert.equal(ownedFile('/repo/mock.yml', [{ dir: '/repo', text: 'dsls:\n  - id: sample\n    match: ["**/mock.yml"]\n' }]), true);
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
  assert.match(section.contents.value, /command:yaml-dsl\.peek\?/);
  assert.match(decodeURIComponent(section.contents.value), /"startLine":2/);
  assert.match(section.contents.value, /data_at_rest_key/);
  assert.equal(section.contents.isTrusted.enabledCommands[0], 'yaml-dsl.peek');
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

test('refs and locals stay underlined', async () => {
  const hereRange = { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } };
  const awayRange = { start: { line: 4, character: 2 }, end: { line: 4, character: 12 } };
  const painted = [];
  const docUri = { scheme: 'file', toString() { return 'file:///repo/mock.yml'; } };
  const yamlEditor = {
    document: { languageId: 'yaml-dsl', uri: docUri },
    setDecorations(decoration, ranges) { painted.push({ decoration, ranges }); },
  };
  const plainEditor = {
    document: { languageId: 'yaml', uri: { scheme: 'file' } },
    setDecorations(decoration, ranges) { painted.push({ decoration, ranges }); },
  };
  const vscode = {
    window: { visibleTextEditors: [yamlEditor, plainEditor, { document: null }] },
    commands: {
      executeCommand: async (cmd) => (cmd === 'vscode.executeLinkProvider' ? [
        { range: hereRange, target: { scheme: 'file', toString() { return 'file:///repo/mock.yml'; } } },
        { range: awayRange, target: { scheme: 'command', toString() { return 'command:yaml-dsl.peek'; } } },
        { range: hereRange, target: { scheme: 'http', toString() { return 'http://example.test'; } } },
        {
          range: awayRange,
          target: {
            scheme: 'file',
            fragment: '1,1',
            toString() { return 'file:///repo/other.yml#1,1'; },
            with() { return { toString() { return 'file:///repo/other.yml'; } }; },
          },
        },
        {},
      ] : []),
    },
  };
  const inFile = { kind: 'in' };
  const outFile = { kind: 'out' };
  await paintUnderlines(vscode, inFile, outFile);
  assert.equal(painted[0].decoration, inFile);
  assert.equal(painted[0].ranges.length, 2);
  assert.equal(painted[1].decoration, outFile);
  assert.equal(painted[1].ranges.length, 2);
  assert.deepEqual(painted[2].ranges, []);
  assert.deepEqual(painted[3].ranges, []);
});

test('a placeholder inside a ref keeps its own color', async () => {
  const text = 'ref redshift.\n${env}_cluster';
  const at = text.indexOf('${env}');
  const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 12 } };
  const empty = { start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, empty: true };
  const painted = [];
  const doc = {
    languageId: 'yaml-dsl',
    uri: { scheme: 'file', toString() { return 'file:///repo/mock.yml'; } },
    getText(asked) { return asked && asked.empty ? '' : text; },
  };
  const editor = {
    document: doc,
    setDecorations(decoration, ranges) { painted.push({ decoration, ranges }); },
  };
  const vscode = {
    window: { visibleTextEditors: [editor] },
    commands: {
      executeCommand: async () => [
        { range, target: { scheme: 'file', toString() { return 'file:///repo/mock.yml'; } } },
        { range: empty, target: { scheme: 'file', toString() { return 'file:///repo/mock.yml'; } } },
      ],
    },
  };
  const inFile = { kind: 'in' };
  const outFile = { kind: 'out' };
  const mark = { kind: 'mark' };
  await paintUnderlines(vscode, inFile, outFile, mark);
  assert.deepEqual(painted[0].ranges[0], {
    start: { line: 0, character: 0 },
    end: placeAt(text, at),
  });
  assert.deepEqual(painted[0].ranges[1], {
    start: placeAt(text, at + '${env}'.length),
    end: placeAt(text, text.length),
  });
  assert.deepEqual(painted[0].ranges[2], empty);
  assert.deepEqual(painted[2].ranges[0], {
    start: placeAt(text, at),
    end: placeAt(text, at + '${env}'.length),
  });
  assert.equal(painted[2].decoration, mark);
});

test('underlines are painted before the language server answers', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const text = 'integration_name ${local.ai_result_integration}:\n  ref redshift.${env}_cluster.endpoint\nsee local.db ${}\n';
  const painted = [];
  const doc = {
    languageId: 'yaml-dsl',
    uri: { scheme: 'file', toString() { return 'file:///repo/mock.yml'; } },
    getText(range) {
      if (!range) return text;
      const line = text.split('\n')[range.start.line] || '';
      return line.slice(range.start.character, range.end.character);
    },
  };
  const editor = {
    document: doc,
    setDecorations(decoration, ranges) { painted.push({ decoration, ranges }); },
  };
  const vscode = {
    window: { visibleTextEditors: [editor] },
    commands: { executeCommand: async () => { await gate; return []; } },
  };
  const config = [
    'dsls:',
    '  - id: sample',
    '    match: ["**/mock.yml"]',
    '    references:',
    "      - pattern: '^ref [a-z0-9_.]+'",
    '        where: whole',
    '        target: { kind: resource, type: type, name: name }',
    '      - pattern: "\\\\$\\\\{local\\\\.(?<name>[a-z0-9_]+)\\\\}"',
    '        where: within',
    '        target: { kind: local, name: name }',
    "      - pattern: 'local\\.[a-z]+'",
    '        where: within',
    '        target: { kind: local, name: name }',
  ].join('\n');
  const inFile = { kind: 'in' };
  const outFile = { kind: 'out' };
  const mark = { kind: 'mark' };
  const pending = paintUnderlines(vscode, inFile, outFile, mark, [{ text: config }]);
  try {
    const linked = painted.find((item) => item.decoration === outFile);
    const covered = linked.ranges.map((range) => doc.getText(range));
    assert.ok(covered.includes('local.ai_result_integration'));
    assert.ok(covered.includes('local.db'));
    assert.equal(covered.includes('${local.ai_result_integration}'), false);
    assert.equal(covered.some((piece) => piece.includes('integration_name')), false);
  } finally {
    release();
  }
  await pending;
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

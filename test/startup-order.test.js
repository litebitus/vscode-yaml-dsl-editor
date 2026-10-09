const test = require('node:test');
const assert = require('node:assert/strict');
const { activateWith } = require('../lib/client');
const { textHashOf } = require('../lib/text-hash');
const { workspaceStorageNameOf } = require('../lib/workspace-identity');
const { scope, declaration, reference, dslEntry, configText } = require('./config-builders');

const MOCK_REPO = '/mock-repo';
const ACTIVE_PATH = `${MOCK_REPO}/dev/mock.yml`;
const OTHER_PATH = `${MOCK_REPO}/staging/mock.yml`;
const ACTIVE_TEXT = 'queue:\n  events: ref queue.mock_dlq\n';
const OTHER_TEXT = 'queue:\n  events: ref queue.mock_dlq\n';
const GLOBAL_STORAGE = '/mock-global-storage';

const mockConfig = configText(dslEntry('resources', {
  scopes: { queue: scope() },
  declarations: [declaration('$.*.*', 'queue')],
  references: [reference('^ref queue\\.(?<name>[a-z_]+)$', 'queue')],
}));

async function settleBackground() {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

function fileUri(fsPath) {
  return { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` };
}

function savedMarksText() {
  const position = { line: 0, character: 6 };
  const suggestion = {
    stackId: `${MOCK_REPO}/mock.yml`,
    id: 'mock-move',
    kind: 'move',
    path: ['queue'],
    overlayCount: 2,
    holders: ['dev', 'staging'],
    absent: [],
    differences: [],
    schemaGroups: [],
    optOutFailures: [],
    optOutConditionalFields: [],
  };
  return JSON.stringify({
    version: 2,
    files: {
      [`file://${ACTIVE_PATH}`]: {
        stackId: `${MOCK_REPO}/mock.yml`,
        textHash: textHashOf(ACTIVE_TEXT),
        marks: [{ range: { start: position, end: position }, suggestion }],
      },
    },
  });
}

function mockDocument(fsPath, text, languageId) {
  return {
    uri: fileUri(fsPath),
    languageId,
    lineCount: text.split('\n').length,
    getText: () => text,
    lineAt: (line) => ({ range: { start: { line, character: 0 }, end: { line, character: 0 } } }),
  };
}

function startupHarness({ editors = [], answerDecorations = () => new Promise(() => {}) } = {}) {
  const events = [];
  const listeners = {};
  const storeFolder = `${GLOBAL_STORAGE}/${workspaceStorageNameOf({ workspaceFolders: [{ uri: fileUri(MOCK_REPO) }] })}`;
  const diskFiles = new Map([
    [`${MOCK_REPO}/yaml-dsl.yml`, mockConfig],
    [ACTIVE_PATH, ACTIVE_TEXT],
    [OTHER_PATH, OTHER_TEXT],
    [`${storeFolder}/suggestion-marks.json`, savedMarksText()],
  ]);
  const decorationTypes = new Map();
  const watchers = [];
  const on = (name) => (fn) => {
    listeners[name] = fn;
    return { dispose() {} };
  };
  const vscode = {
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    FileDecoration: class { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } },
    InlayHint: class { constructor(position, label) { Object.assign(this, { position, label }); } },
    InlayHintLabelPart: class { constructor(value) { this.value = value; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    EventEmitter: class {
      constructor() { this.event = () => ({ dispose() {} }); }
      fire() {}
      dispose() {}
    },
    Uri: {
      joinPath: (base, ...parts) => fileUri([base.fsPath || base, ...parts].join('/')),
      parse: (value) => fileUri(String(value).replace(/^file:\/\//, '')),
    },
    workspace: {
      workspaceFolders: [{ uri: fileUri(MOCK_REPO) }],
      textDocuments: editors.map((editor) => editor.document),
      fs: {
        readFile: async (uri) => {
          events.push(`read ${uri.fsPath}`);
          if (!diskFiles.has(uri.fsPath)) throw new Error(`mock missing ${uri.fsPath}`);
          return Buffer.from(diskFiles.get(uri.fsPath), 'utf8');
        },
        writeFile: async () => {},
        createDirectory: async () => {},
        delete: async () => {},
      },
      findFiles: async () => {
        events.push('search workspace');
        return [];
      },
      getConfiguration: () => ({ get: (key) => (key && key.startsWith('cache.') ? 32 : undefined), update: async () => {} }),
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      createFileSystemWatcher: (pattern) => {
        const watcher = {
          pattern,
          onDidChange: (fn) => { watcher.change = fn; return { dispose() {} }; },
          onDidCreate: (fn) => { watcher.create = fn; return { dispose() {} }; },
          onDidDelete: (fn) => { watcher.delete = fn; return { dispose() {} }; },
          dispose() {},
        };
        watchers.push(watcher);
        return watcher;
      },
      onDidOpenTextDocument: on('open'),
      onDidChangeTextDocument: on('change'),
      onDidCloseTextDocument: on('close'),
      onDidChangeConfiguration: on('configuration'),
      onDidChangeWorkspaceFolders: on('folders'),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line) => { events.push(`log ${line.replace(/^\[[^\]]+\] /, '')}`); },
        dispose() {},
      }),
      activeTextEditor: editors[0] || null,
      visibleTextEditors: editors,
      createTextEditorDecorationType(options) {
        const decorationType = { options, dispose() {} };
        decorationTypes.set(decorationType, options);
        return decorationType;
      },
      onDidChangeActiveTextEditor: on('active'),
      onDidChangeVisibleTextEditors: on('visible'),
      registerFileDecorationProvider: () => ({ dispose() {} }),
    },
    languages: {
      setTextDocumentLanguage: async (doc, languageId) => {
        events.push(`language ${doc.uri.fsPath} ${languageId}`);
        doc.languageId = languageId;
        return doc;
      },
      registerInlayHintsProvider: () => ({ dispose() {} }),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  };
  const attachPainter = (editor) => {
    editor.setDecorations = (decorationType, ranges) => {
      if (ranges.length === 0) return;
      const options = decorationTypes.get(decorationType) || {};
      const kind = String(options.gutterIconPath || '').includes('lightbulb') ? 'light bulb' : 'underline';
      events.push(`${kind} ${editor.document.uri.fsPath}`);
    };
    return editor;
  };
  for (const editor of editors) attachPainter(editor);
  const client = {
    stop() {},
    onNotification() {},
    async sendNotification(method, params) {
      events.push(`notify ${method}${params && params.path !== undefined ? ` ${params.path}` : ''}`);
    },
    sendRequest(method, params) {
      events.push(`request ${method}${params && params.uri ? ` ${params.uri}` : ''}`);
      return method === 'yaml-dsl/decorations' ? answerDecorations(params) : Promise.resolve(null);
    },
  };
  const context = {
    subscriptions: [],
    extensionUri: fileUri('/mock-extension'),
    globalStorageUri: fileUri(GLOBAL_STORAGE),
  };
  const start = () => {
    events.push('start language server');
    return client;
  };
  return { vscode, context, start, events, listeners, attachPainter, watchers, diskFiles };
}

function indexOf(events, prefix) {
  const index = events.findIndex((event) => event.startsWith(prefix));
  assert.notEqual(index, -1, `expected an event starting "${prefix}" in ${JSON.stringify(events, null, 2)}`);
  return index;
}

function assertInOrder(events, prefixes) {
  const positions = prefixes.map((prefix) => indexOf(events, prefix));
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index - 1] < positions[index],
      `"${prefixes[index - 1]}" must come before "${prefixes[index]}" in ${JSON.stringify(events, null, 2)}`,
    );
  }
}

test('startup shows the file, colors it, paints saved suggestions, and only then starts analysis', async () => {
  const editor = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml') };
  const harness = startupHarness({ editors: [editor] });
  await activateWith(harness.vscode, harness.context, harness.start);
  await settleBackground();
  assertInOrder(harness.events, [
    `language ${ACTIVE_PATH} yaml-dsl`,
    `underline ${ACTIVE_PATH}`,
    `light bulb ${ACTIVE_PATH}`,
    'start language server',
    'notify yaml-dsl/config',
    `notify yaml-dsl/active ${ACTIVE_PATH}`,
    `request yaml-dsl/decorations file://${ACTIVE_PATH}`,
  ]);
});

test('activation finishes while analysis never answers', async () => {
  const editor = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml-dsl') };
  const harness = startupHarness({ editors: [editor] });
  const activation = activateWith(harness.vscode, harness.context, harness.start);
  const outcome = await Promise.race([activation.then(() => 'activated'), settleBackground().then(() => 'blocked')]);
  assert.equal(outcome, 'activated');
  const handle = await activation;
  assert.equal(typeof harness.listeners.open, 'function');
  assert.equal(typeof harness.listeners.active, 'function');
  const settled = await Promise.race([handle.startup.then(() => 'finished'), new Promise((resolve) => {
    setImmediate(() => resolve('still analyzing'));
  })]);
  assert.equal(settled, 'still analyzing');
});

test('startup reads no file of the workspace before painting, searches nothing and loads no stack on its own', async () => {
  const editor = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml-dsl') };
  const harness = startupHarness({ editors: [editor], answerDecorations: async () => null });
  const handle = await activateWith(harness.vscode, harness.context, harness.start);
  await handle.startup;
  const firstPaint = indexOf(harness.events, `light bulb ${ACTIVE_PATH}`);
  const readsBeforePaint = harness.events.slice(0, firstPaint).filter((event) => event.startsWith('read '));
  assert.deepEqual(readsBeforePaint.filter((event) => !event.endsWith('yaml-dsl.yml') && !event.endsWith('.json')), []);
  assert.equal(harness.events.includes('search workspace'), false);
  assert.equal(harness.events.some((event) => event.startsWith('notify yaml-dsl/warm')), false);
  assert.ok(indexOf(harness.events, `read ${ACTIVE_PATH}`) > indexOf(harness.events, 'start language server'));
});

test('a file opened after startup is claimed and underlined without waiting on any analysis', async () => {
  const active = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml-dsl') };
  const harness = startupHarness({ editors: [active] });
  await activateWith(harness.vscode, harness.context, harness.start);
  const opened = harness.attachPainter({ document: mockDocument(OTHER_PATH, OTHER_TEXT, 'yaml') });
  harness.vscode.window.visibleTextEditors.push(opened);
  harness.events.length = 0;
  harness.listeners.open(opened.document);
  await settleBackground();
  assert.deepEqual(harness.events.filter((event) => event.startsWith('language')), [`language ${OTHER_PATH} yaml-dsl`]);
  assertInOrder(harness.events, [
    `language ${OTHER_PATH} yaml-dsl`,
    `underline ${OTHER_PATH}`,
    `request yaml-dsl/decorations file://${OTHER_PATH}`,
  ]);
});

test('the active file is sent to the server before its language is switched, and the latest switch always lands', async () => {
  const first = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml') };
  const harness = startupHarness({ editors: [first] });
  await activateWith(harness.vscode, harness.context, harness.start);
  const second = { document: mockDocument(OTHER_PATH, OTHER_TEXT, 'yaml'), setDecorations() {} };
  harness.events.length = 0;
  harness.vscode.window.activeTextEditor = second;
  const firstSwitch = harness.listeners.active();
  harness.vscode.window.activeTextEditor = first;
  const secondSwitch = harness.listeners.active();
  await Promise.all([firstSwitch, secondSwitch]);
  const published = harness.events.filter((event) => event.startsWith('notify yaml-dsl/active'));
  assert.equal(published.at(0), `notify yaml-dsl/active ${OTHER_PATH}`);
  assert.equal(published.at(-1), `notify yaml-dsl/active ${ACTIVE_PATH}`);
});

test('saved suggestions for a file changed while the editor was closed are refreshed after the config reaches the server', async () => {
  const editor = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml-dsl') };
  const harness = startupHarness({ editors: [editor], answerDecorations: async () => null });
  harness.diskFiles.set(ACTIVE_PATH, 'queue:\n  events: ref queue.mock_changed\n');
  const handle = await activateWith(harness.vscode, harness.context, harness.start);
  await handle.startup;
  assertInOrder(harness.events, [
    `light bulb ${ACTIVE_PATH}`,
    'notify yaml-dsl/config',
    'notify yaml-dsl/refreshSuggestions',
  ]);
});

test('a DSL file that changes on disk drops its saved suggestions and has its stack worked out again', async () => {
  const editor = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml-dsl') };
  const harness = startupHarness({ editors: [editor], answerDecorations: async () => null });
  const handle = await activateWith(harness.vscode, harness.context, harness.start);
  await handle.startup;
  const ownedWatchers = harness.watchers.filter((watcher) => typeof watcher.pattern !== 'string');
  assert.deepEqual(ownedWatchers.map((watcher) => `${watcher.pattern.base} ${watcher.pattern.pattern}`), [
    `${MOCK_REPO} **/mock.yml`,
  ]);
  harness.events.length = 0;
  await ownedWatchers[0].change(fileUri(ACTIVE_PATH));
  assert.deepEqual(harness.events.filter((event) => event.startsWith('notify')), []);
  harness.diskFiles.set(ACTIVE_PATH, 'queue:\n  events: ref queue.mock_changed\n');
  await ownedWatchers[0].change(fileUri(ACTIVE_PATH));
  assert.deepEqual(harness.events.filter((event) => event.startsWith('notify')), ['notify yaml-dsl/refreshSuggestions']);
});

test('every visible file paints its analysis as it lands, never behind another file\'s', async () => {
  const slow = { document: mockDocument(ACTIVE_PATH, ACTIVE_TEXT, 'yaml-dsl') };
  const fast = { document: mockDocument(OTHER_PATH, OTHER_TEXT, 'yaml-dsl') };
  const reference = { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 28 } }, kind: 'local' };
  const harness = startupHarness({
    editors: [slow, fast],
    answerDecorations: (params) => (params.uri.endsWith(ACTIVE_PATH)
      ? new Promise(() => {})
      : Promise.resolve({ problems: [], references: [reference] })),
  });
  await activateWith(harness.vscode, harness.context, harness.start);
  await settleBackground();
  const fastPaints = harness.events.filter((event) => event === `underline ${OTHER_PATH}`);
  assert.ok(fastPaints.length >= 2, JSON.stringify(harness.events, null, 2));
  harness.events.length = 0;
  harness.listeners.visible();
  await settleBackground();
  assert.ok(harness.events.includes(`underline ${OTHER_PATH}`), JSON.stringify(harness.events, null, 2));
});

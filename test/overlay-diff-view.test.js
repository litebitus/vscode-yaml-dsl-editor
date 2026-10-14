const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DSL_SELECTION_CONTEXT_KEY,
  OVERLAY_DIFF_COLOR_IDS,
  OVERLAY_DIFF_SCHEME,
  createOverlayDiffViews,
} = require('../lib/overlay-diff-view');
const { OVERLAY_DIFF_COMMAND, CHOOSE_DIFF_OVERLAYS_COMMAND } = require('../lib/overlay-diff-command');

function fakeEditor(uri) {
  const decorations = new Map();
  return {
    document: { uri },
    decorations,
    setDecorations(decorationType, ranges) { decorations.set(decorationType, ranges); },
  };
}

function fakeVscode({ picks, activeEditor } = {}) {
  const vscode = {
    decorationTypes: [],
    commands: {},
    providers: {},
    quickPicks: [],
    shown: [],
    warnings: [],
    languagesSet: [],
    ThemeColor: class { constructor(id) { this.id = id; } },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
      }
    },
    ViewColumn: { Beside: -2 },
    EventEmitter: class {
      constructor() {
        this.fired = [];
        this.event = () => ({ dispose() {} });
        this.fire = (value) => this.fired.push(value);
      }
      dispose() {}
    },
    Uri: {
      from(parts) {
        return { ...parts, toString: () => `${parts.scheme}:${parts.path}` };
      },
    },
    window: {
      activeTextEditor: activeEditor || null,
      visibleTextEditors: [],
      createTextEditorDecorationType(options) {
        const decorationType = { options, dispose() {} };
        vscode.decorationTypes.push(decorationType);
        return decorationType;
      },
      async showQuickPick(items, options) {
        vscode.quickPicks.push({ items, options });
        return picks ? picks(items) : items;
      },
      async showTextDocument(doc, options) {
        vscode.shown.push({ doc, options });
        const editor = fakeEditor(doc.uri);
        vscode.window.visibleTextEditors.push(editor);
        return editor;
      },
      showWarningMessage(message) { vscode.warnings.push(message); },
    },
    workspace: {
      registerTextDocumentContentProvider(scheme, provider) {
        vscode.providers[scheme] = provider;
        return { dispose() {} };
      },
      async openTextDocument(uri) { return { uri, languageId: 'plaintext' }; },
    },
    languages: {
      async setTextDocumentLanguage(doc, languageId) {
        vscode.languagesSet.push(languageId);
        return { ...doc, languageId };
      },
    },
  };
  vscode.commands.registerCommand = (name, fn) => {
    vscode.commands[name] = fn;
    return { dispose() {} };
  };
  vscode.executed = [];
  vscode.commands.executeCommand = async (...args) => { vscode.executed.push(args); };
  return vscode;
}

function fakeClient(answers) {
  const requests = [];
  return {
    requests,
    async sendRequest(method, params) {
      requests.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params) : answer;
    },
  };
}

const range = { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } };
const target = { uri: 'file:///repo/group/overlay-1/concern-1/mock.yml', range };

function lineOf(text, differenceIndex, struck = null) {
  return { text, differenceIndex, struck };
}

const diff = {
  title: 'group/concern-1',
  lines: [
    lineOf('mocktype:', null),
    ...Array.from({ length: 7 }, (_, index) => lineOf(`  key${index}: ${index}  # overlay-1`, index)),
    lineOf('  gone:  # overlay-2', 7, { start: 2, end: 7 }),
  ],
};

const overlayNames = ['overlay-1', 'overlay-2', 'overlay-3'];
const stack = { title: 'group/concern-1', overlayNames };

test('the button opens the diff of every overlay beside the file at once, no question asked', async () => {
  const vscode = fakeVscode();
  const client = fakeClient({ 'yaml-dsl/overlayDiffStack': stack, 'yaml-dsl/overlayDiff': diff });
  const views = createOverlayDiffViews(vscode, client);
  assert.equal(typeof vscode.commands[OVERLAY_DIFF_COMMAND], 'function');
  await vscode.commands[OVERLAY_DIFF_COMMAND](target);
  assert.equal(vscode.quickPicks.length, 0);
  assert.deepEqual(client.requests.at(-1), {
    method: 'yaml-dsl/overlayDiff',
    params: { ...target, overlayNames },
  });
  const [{ doc, options }] = vscode.shown;
  assert.equal(doc.uri.scheme, OVERLAY_DIFF_SCHEME);
  assert.equal(doc.uri.path, '/group／concern-1');
  assert.equal(doc.languageId, 'yaml-dsl-overlay-diff');
  assert.deepEqual(options, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  const content = vscode.providers[OVERLAY_DIFF_SCHEME].provideTextDocumentContent(doc.uri);
  assert.equal(content, `${diff.lines.map((line) => line.text).join('\n')}\n`);
  assert.equal(vscode.providers[OVERLAY_DIFF_SCHEME].provideTextDocumentContent({ toString: () => 'other' }), '');
  assert.equal(views.disposables.length > 0, true);
});

test('a menu click hands the file\'s uri, and the diff takes that editor\'s selection', async () => {
  const activeEditor = {
    document: { uri: { toString: () => target.uri } },
    selection: { start: { line: 1, character: 0, extra: true }, end: { line: 3, character: 0 } },
  };
  const vscode = fakeVscode({ activeEditor });
  const client = fakeClient({ 'yaml-dsl/overlayDiffStack': stack, 'yaml-dsl/overlayDiff': diff });
  const views = createOverlayDiffViews(vscode, client);
  await views.diffAcrossOverlays({ scheme: 'file', path: '/repo/group/overlay-1/concern-1/mock.yml' });
  assert.deepEqual(client.requests.at(-1).params, { ...target, overlayNames });
  vscode.window.activeTextEditor = null;
  await views.diffAcrossOverlays();
  assert.equal(client.requests.length, 2);
});

test('the diff tab\'s button chooses overlays, the current ones checked, and renders the same diff with them', async () => {
  const vscode = fakeVscode({ picks: (items) => items.filter((item) => item.label !== 'overlay-2') });
  const client = fakeClient({ 'yaml-dsl/overlayDiffStack': stack, 'yaml-dsl/overlayDiff': diff });
  const views = createOverlayDiffViews(vscode, client);
  await views.diffAcrossOverlays(target);
  const [{ doc }] = vscode.shown;
  await vscode.commands[CHOOSE_DIFF_OVERLAYS_COMMAND](doc.uri);
  assert.deepEqual(vscode.quickPicks[0].items, overlayNames.map((label) => ({ label, picked: true })));
  assert.equal(vscode.quickPicks[0].options.canPickMany, true);
  assert.deepEqual(client.requests.at(-1).params, { ...target, overlayNames: ['overlay-1', 'overlay-3'] });
  assert.equal(vscode.shown.at(-1).doc.uri.toString(), doc.uri.toString());
  vscode.window.activeTextEditor = vscode.window.visibleTextEditors.at(-1);
  await views.chooseDiffOverlays();
  assert.deepEqual(vscode.quickPicks[1].items.map((item) => item.picked), [true, false, true]);
});

test('the overlay choice changes nothing when cancelled, emptied, or opened on no diff', async () => {
  const cancelling = fakeVscode({ picks: () => undefined });
  const client = fakeClient({ 'yaml-dsl/overlayDiffStack': stack, 'yaml-dsl/overlayDiff': diff });
  const views = createOverlayDiffViews(cancelling, client);
  await views.diffAcrossOverlays(target);
  const requestsBefore = client.requests.length;
  await views.chooseDiffOverlays(cancelling.shown[0].doc.uri);
  const emptying = fakeVscode({ picks: () => [] });
  const emptied = createOverlayDiffViews(emptying, client);
  await emptied.diffAcrossOverlays(target);
  await emptied.chooseDiffOverlays(emptying.shown[0].doc.uri);
  assert.equal(client.requests.length, requestsBefore + 2);
  await views.chooseDiffOverlays({ toString: () => 'file:///repo/plain.yml' });
  await views.chooseDiffOverlays();
  assert.equal(cancelling.quickPicks.length, 1);
});

test('each difference takes the next palette color, cycling, with struck keys and a marker column', async () => {
  const vscode = fakeVscode();
  const client = fakeClient({
    'yaml-dsl/overlayDiffStack': { ...stack, overlayNames: ['overlay-1'] },
    'yaml-dsl/overlayDiff': diff,
  });
  const views = createOverlayDiffViews(vscode, client);
  await views.diffAcrossOverlays(target);
  const [editor] = vscode.window.visibleTextEditors;
  const colorTypes = vscode.decorationTypes.filter((decorationType) => decorationType.options.backgroundColor);
  assert.deepEqual(colorTypes.map((colorType) => colorType.options.backgroundColor.id), OVERLAY_DIFF_COLOR_IDS);
  assert.deepEqual(OVERLAY_DIFF_COLOR_IDS, [1, 2, 3, 4, 5, 6].map((n) => `yamlDslEditor.overlayDiff.difference${n}`));
  const paintedLines = (decorationType) => editor.decorations.get(decorationType).map((painted) => painted.startLine);
  assert.deepEqual(colorTypes.map(paintedLines), [[1, 7], [2, 8], [3], [4], [5], [6]]);
  const typeWith = (predicate) => vscode.decorationTypes.find((decorationType) => predicate(decorationType.options));
  const struck = editor.decorations.get(typeWith((options) => options.textDecoration === 'line-through'));
  assert.deepEqual(struck, [new vscode.Range(8, 2, 8, 7)]);
  const marker = typeWith((options) => options.before && options.before.contentText === '~');
  assert.equal(editor.decorations.get(marker).length, 8);
  const spacer = typeWith((options) => options.before && options.before.contentText === ' ');
  assert.deepEqual(paintedLines(spacer), [0]);
  editor.decorations.clear();
  const unrelated = fakeEditor({ toString: () => 'file:///repo/other.yml' });
  vscode.window.visibleTextEditors.push(unrelated, { document: null });
  views.paintVisible();
  assert.equal(editor.decorations.size, vscode.decorationTypes.length);
  assert.equal(unrelated.decorations.size, 0);
});

test('a stack with no overlays opens nothing, and a failing request is shown as a warning', async () => {
  const vscode = fakeVscode();
  const noOverlays = { ...stack, overlayNames: [] };
  await createOverlayDiffViews(vscode, fakeClient({ 'yaml-dsl/overlayDiffStack': noOverlays })).diffAcrossOverlays(target);
  await createOverlayDiffViews(vscode, fakeClient({ 'yaml-dsl/overlayDiffStack': null })).diffAcrossOverlays(target);
  assert.equal(vscode.shown.length, 0);
  const unanswered = fakeVscode();
  await createOverlayDiffViews(unanswered, fakeClient({
    'yaml-dsl/overlayDiffStack': { ...stack, overlayNames: ['overlay-1'] },
    'yaml-dsl/overlayDiff': null,
  })).diffAcrossOverlays(target);
  assert.equal(unanswered.shown.length, 0);
  const failing = fakeVscode();
  await createOverlayDiffViews(failing, fakeClient({
    'yaml-dsl/overlayDiffStack': new Error('mock server stopped'),
  })).diffAcrossOverlays(target);
  assert.deepEqual(failing.warnings, ['Diff across overlays: mock server stopped']);
});

test('the diff button\'s context key follows whether the active editor is a DSL file on disk with a selection', async () => {
  const vscode = fakeVscode();
  const views = createOverlayDiffViews(vscode, fakeClient({}));
  const editorOf = (languageId, scheme, isEmpty) => ({
    document: { languageId, uri: { scheme } },
    selection: { isEmpty },
  });
  const setContexts = () => vscode.executed.filter(([command]) => command === 'setContext');
  await views.selectionContextChanged();
  vscode.window.activeTextEditor = editorOf('yaml-dsl', 'file', false);
  await views.selectionContextChanged();
  await views.selectionContextChanged();
  vscode.window.activeTextEditor = editorOf('yaml-dsl', 'file', true);
  await views.selectionContextChanged();
  vscode.window.activeTextEditor = editorOf('yaml', 'file', false);
  await views.selectionContextChanged();
  vscode.window.activeTextEditor = editorOf('yaml-dsl', 'yaml-dsl-fold', false);
  await views.selectionContextChanged();
  assert.deepEqual(setContexts(), [
    ['setContext', DSL_SELECTION_CONTEXT_KEY, false],
    ['setContext', DSL_SELECTION_CONTEXT_KEY, true],
    ['setContext', DSL_SELECTION_CONTEXT_KEY, false],
  ]);
  assert.equal(DSL_SELECTION_CONTEXT_KEY, require('../package.json').contributes.menus['editor/title'][0].when);
});

function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); },
    async fireAll() {
      const due = [...pending];
      pending.clear();
      for (const timer of due) timer.callback();
      for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
    },
  };
}

function selectingEditor(uri, selection, languageId = 'yaml-dsl') {
  return {
    document: { languageId, uri: { scheme: 'file', toString: () => uri } },
    selection: { ...selection, isEmpty: false },
  };
}

test('an open diff follows the selection in its stack, keeping its overlays, without taking focus', async () => {
  const vscode = fakeVscode({ picks: (items) => items.filter((item) => item.label !== 'overlay-2') });
  const timers = fakeTimers();
  const followed = { title: 'group/concern-1', lines: [lineOf('# overlay-1, overlay-3: no differences', null)] };
  const answers = { 'yaml-dsl/overlayDiffStack': stack, 'yaml-dsl/overlayDiff': diff };
  const client = fakeClient(answers);
  const views = createOverlayDiffViews(vscode, client, timers);
  await views.diffAcrossOverlays(target);
  await views.chooseDiffOverlays(vscode.shown[0].doc.uri);
  const shownBefore = vscode.shown.length;
  answers['yaml-dsl/overlayDiff'] = followed;
  const moved = { start: { line: 5, character: 0 }, end: { line: 6, character: 0 } };
  views.followSelection(selectingEditor(target.uri, { start: { line: 4, character: 0 }, end: moved.end }));
  views.followSelection(selectingEditor(target.uri, moved));
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending][0].delay, 200);
  await timers.fireAll();
  assert.deepEqual(client.requests.at(-1).params, {
    uri: target.uri,
    range: moved,
    overlayNames: ['overlay-1', 'overlay-3'],
  });
  const viewUri = vscode.shown[0].doc.uri;
  assert.equal(vscode.providers[OVERLAY_DIFF_SCHEME].provideTextDocumentContent(viewUri), `${followed.lines[0].text}\n`);
  assert.equal(vscode.shown.length, shownBefore);
});

test('the selection is not followed without an open diff of its stack, outside a DSL file, or past a newer one', async () => {
  const vscode = fakeVscode();
  const timers = fakeTimers();
  const answers = { 'yaml-dsl/overlayDiffStack': stack, 'yaml-dsl/overlayDiff': diff };
  const client = fakeClient(answers);
  const views = createOverlayDiffViews(vscode, client, timers);
  views.followSelection(selectingEditor(target.uri, range));
  assert.equal(timers.pending.size, 0);
  await views.diffAcrossOverlays(target);
  views.followSelection(selectingEditor(target.uri, range, 'yaml'));
  views.followSelection(null);
  assert.equal(timers.pending.size, 0);
  const requestsBefore = client.requests.length;
  answers['yaml-dsl/overlayDiffStack'] = { title: 'other/stack', overlayNames };
  views.followSelection(selectingEditor(target.uri, range));
  await timers.fireAll();
  assert.equal(client.requests.length, requestsBefore + 1);
  answers['yaml-dsl/overlayDiffStack'] = null;
  views.followSelection(selectingEditor(target.uri, range));
  await timers.fireAll();
  answers['yaml-dsl/overlayDiffStack'] = stack;
  let releaseStale;
  answers['yaml-dsl/overlayDiff'] = () => new Promise((resolve) => { releaseStale = resolve; });
  views.followSelection(selectingEditor(target.uri, range));
  await timers.fireAll();
  answers['yaml-dsl/overlayDiff'] = null;
  views.followSelection(selectingEditor(target.uri, range));
  await timers.fireAll();
  releaseStale({ title: 'group/concern-1', lines: [lineOf('# stale', null)] });
  await timers.fireAll();
  const content = vscode.providers[OVERLAY_DIFF_SCHEME].provideTextDocumentContent(vscode.shown[0].doc.uri);
  assert.equal(content, `${diff.lines.map((line) => line.text).join('\n')}\n`);
  views.followSelection(selectingEditor(target.uri, range));
  views.disposables.forEach((disposable) => disposable.dispose());
  assert.equal(timers.pending.size, 0);
});

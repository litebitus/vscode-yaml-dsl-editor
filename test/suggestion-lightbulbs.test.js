const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPLY_COMMAND,
  hoverMarkdownText,
  paintLightbulbs,
  suggestionInlayHints,
  applySuggestion,
} = require('../lib/suggestion-lightbulbs');
const { activateWith } = require('../lib/client');

const moveSuggestion = {
  stackId: '/repo/mock.yml',
  id: 'mock-move',
  kind: 'move',
  path: ['queue', 'events'],
  overlayCount: 4,
  holders: ['dev', 'staging', 'production'],
  absent: ['uat'],
  differences: [{
    name: 'events_size',
    values: [{ text: '1', overlays: ['dev', 'staging'] }, { text: '`2`', overlays: ['production'] }],
  }],
  schemaGroups: [],
  optOutFailures: [],
  optOutConditionalFields: [],
};

const applyArgument = { stackId: '/repo/mock.yml', id: 'mock-move' };
const link = `command:${APPLY_COMMAND}?${encodeURIComponent(JSON.stringify(applyArgument))}`;

test('the hover names the block, its differences and the overlays that opt out, with the move\'s link', () => {
  assert.equal(hoverMarkdownText(moveSuggestion), [
    '`queue.events` is common to 3 of 4 overlays. Move it to the common layer.',
    '',
    '1 difference becomes a local:',
    '',
    "- `events_size`: `1` (dev, staging), `'2'` (production)",
    '',
    'Opts out with `{}`: uat',
    '',
    `[Move to common layer](${link})`,
  ].join('\n'));
  const [difference] = moveSuggestion.differences;
  const twoDifferences = { ...moveSuggestion, absent: [], differences: [difference, difference] };
  assert.match(hoverMarkdownText(twoDifferences), /^2 differences become locals:$/m);
  assert.doesNotMatch(hoverMarkdownText({ ...moveSuggestion, absent: [], differences: [] }), /difference|Opts out/);
  assert.equal(hoverMarkdownText({ ...moveSuggestion, kind: 'delete', holders: ['dev'] }), [
    '`queue.events` in dev is the same as in the common layer. Delete it.',
    '',
    `[Delete it](${link})`,
  ].join('\n'));
});

function fakeVscode(editors) {
  return {
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
      }
    },
    MarkdownString: class { constructor(value) { this.value = value; } },
    window: {
      visibleTextEditors: editors,
      warnings: [],
      showWarningMessage(message) { this.warnings.push(message); },
    },
  };
}

function recordingEditor(uri, painted) {
  return {
    document: { uri: { toString: () => uri } },
    setDecorations(mark, ranges) { painted.push({ mark, ranges }); },
  };
}

test('light bulbs paint on the visible editors their file\'s marks name, and clear elsewhere', () => {
  const painted = [];
  const others = [];
  const position = { line: 2, character: 8 };
  const mark = { range: { start: position, end: position }, suggestion: moveSuggestion };
  const vscode = fakeVscode([
    recordingEditor('file:///repo/dev/mock.yml', painted),
    recordingEditor('file:///repo/other.yml', others),
    { document: null },
  ]);
  paintLightbulbs(vscode, 'lightbulb', new Map([['file:///repo/dev/mock.yml', [mark]]]));
  assert.equal(painted[0].mark, 'lightbulb');
  assert.deepEqual({ ...painted[0].ranges[0] }, { startLine: 2, startCharacter: 8, endLine: 2, endCharacter: 8 });
  assert.deepEqual(others[0].ranges, []);
  paintLightbulbs({ window: {} }, 'lightbulb', new Map());
});

function inlayVscode() {
  return {
    ...fakeVscode([]),
    InlayHintLabelPart: class { constructor(value) { this.value = value; } },
    InlayHint: class { constructor(position, label) { this.position = position; this.label = label; } },
  };
}

function documentOf(uri, lines) {
  return {
    uri: { toString: () => uri },
    lineCount: lines.length,
    lineAt: (line) => ({ range: { end: { line, character: lines[line].length } } }),
  };
}

test('each suggestion is an inlay hint at the end of its line, its tooltip the details and the link in it the move', () => {
  const vscode = inlayVscode();
  const position = { line: 1, character: 6 };
  const marksByUri = new Map([['file:///repo/dev/mock.yml', [
    { range: { start: position, end: position }, suggestion: moveSuggestion },
    {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } },
      suggestion: { ...moveSuggestion, kind: 'delete' },
    },
    { range: { start: { line: 9, character: 2 }, end: { line: 9, character: 2 } }, suggestion: moveSuggestion },
  ]]]);
  const document = documentOf('file:///repo/dev/mock.yml', ['queue:', 'queue:  # edited since', 'x']);
  const [moveHint, deleteHint, ...rest] = suggestionInlayHints(vscode, marksByUri, document);
  assert.equal(rest.length, 0);
  assert.deepEqual(moveHint.position, { line: 1, character: 22 });
  assert.equal(moveHint.paddingLeft, true);
  const [label] = moveHint.label;
  assert.equal(label.value, '💡 move to common layer');
  assert.deepEqual(label.tooltip.isTrusted, { enabledCommands: [APPLY_COMMAND] });
  assert.match(label.tooltip.value, /is common to 3 of 4 overlays/);
  assert.equal(label.command, undefined);
  assert.match(label.tooltip.value, /command:yaml-dsl-editor\.applySuggestion\?/);
  assert.equal(deleteHint.label[0].value, '💡 same in common layer');
  assert.deepEqual(suggestionInlayHints(vscode, marksByUri, documentOf('file:///other.yml', ['a'])), []);
});

const schemasDiffer = {
  ...moveSuggestion,
  kind: 'potential_move',
  absent: ['uat'],
  differences: [],
  schemaGroups: [
    { overlays: ['dev', 'staging'], state: 'constrained' },
    { overlays: ['production'], state: 'not_allowed' },
    { overlays: ['uat'], state: 'no_schema' },
  ],
  optOutFailures: [],
};

const optOutFails = {
  ...schemasDiffer,
  schemaGroups: [],
  optOutFailures: [{
    overlay: 'uat',
    messages: ["`queue.events`: must have required property 'size'", '`queue.events`: must match a schema in anyOf'],
  }],
};

test('a potential move\'s hover lists the overlays and the schema\'s messages, with no link', () => {
  assert.equal(hoverMarkdownText(schemasDiffer), [
    '`queue.events` is common to 3 of 4 overlays, but its schema differs between overlays:',
    '',
    '- dev, staging',
    '- production: its schema does not allow it',
    '- uat: it has no schema',
    '',
    "Make the overlays' schemas agree on it to move it to the common layer.",
  ].join('\n'));
  assert.equal(hoverMarkdownText(optOutFails), [
    '`queue.events` is common to 3 of 4 overlays, but the `{}` opt-out would fail the schema in:',
    '',
    '- uat',
    "  - `queue.events`: must have required property 'size'",
    '  - `queue.events`: must match a schema in anyOf',
  ].join('\n'));
  assert.doesNotMatch(hoverMarkdownText(schemasDiffer) + hoverMarkdownText(optOutFails), /command:/);
});

test('a move whose opt-out leaves out a conditionally required field warns and keeps its link', () => {
  const conditional = {
    ...moveSuggestion,
    optOutConditionalFields: [{ overlay: 'uat', fields: ['queue.events.size', 'queue.events.kind'] }],
  };
  assert.equal(hoverMarkdownText(conditional), [
    '`queue.events` is common to 3 of 4 overlays, but the `{}` opt-out leaves out a conditionally required field in:',
    '',
    '- uat',
    '  - `queue.events.size` is [~required]',
    '  - `queue.events.kind` is [~required]',
    '',
    'The extension cannot tell whether the move is safe.',
    '',
    '1 difference becomes a local:',
    '',
    "- `events_size`: `1` (dev, staging), `'2'` (production)",
    '',
    `[Move to common layer](${link})`,
  ].join('\n'));
  const vscode = inlayVscode();
  const at = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const marksByUri = new Map([['file:///repo/dev/mock.yml', [{ range: at, suggestion: conditional }]]]);
  const [hint] = suggestionInlayHints(vscode, marksByUri, documentOf('file:///repo/dev/mock.yml', ['queue:']));
  assert.equal(hint.label[0].value, '💡 potential move: overlay (uat) opt-out leaves out a conditionally required field');
});

test('a potential move\'s inlay hint names the check that failed', () => {
  const vscode = inlayVscode();
  const at = (line) => ({ start: { line, character: 0 }, end: { line, character: 0 } });
  const marksByUri = new Map([['file:///repo/dev/mock.yml', [
    { range: at(0), suggestion: schemasDiffer },
    { range: at(1), suggestion: optOutFails },
    { range: at(2), suggestion: { ...optOutFails, optOutFailures: [...optOutFails.optOutFailures, { overlay: 'qa', messages: [] }] } },
  ]]]);
  const document = documentOf('file:///repo/dev/mock.yml', ['queue:', 'queue:', 'queue:']);
  assert.deepEqual(suggestionInlayHints(vscode, marksByUri, document).map((hint) => hint.label[0].value), [
    '💡 potential move: overlay schemas differ',
    '💡 potential move: overlay (uat) opt-out would fail the schema',
    '💡 potential move: overlay (uat, qa) opt-out would fail the schema',
  ]);
});

test('applying a suggestion saves every file it changed, and nothing written is a warning', async () => {
  const vscode = fakeVscode([]);
  const asked = [];
  const client = (answer) => ({
    async sendRequest(method, params) {
      asked.push({ method, params });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const saved = [];
  vscode.Uri = { parse: (uri) => ({ parsed: uri }) };
  vscode.workspace = {
    openTextDocument: async (uri) => ({
      async save() {
        saved.push(uri.parsed);
        return uri.parsed !== 'file:///repo/locked.yml';
      },
    }),
  };
  const argument = { stackId: '/repo/mock.yml', id: 'mock-move' };
  await applySuggestion(vscode, client({ applied: true, message: null, uris: ['file:///repo/mock.yml'] }), argument);
  await applySuggestion(vscode, client({ applied: false, message: 'no longer applies' }), argument);
  await applySuggestion(vscode, client(new Error('down')), argument);
  await applySuggestion(vscode, client({ applied: true, message: null, uris: ['file:///repo/locked.yml'] }), argument);
  await applySuggestion(vscode, client({ applied: true, message: null }), argument);
  await applySuggestion(vscode, client(null), { stackId: '/repo/mock.yml' });
  assert.deepEqual(asked.map((item) => item.method), Array(5).fill('yaml-dsl/applySuggestion'));
  assert.deepEqual(saved, ['file:///repo/mock.yml', 'file:///repo/locked.yml']);
  assert.deepEqual(vscode.window.warnings, [
    'no longer applies',
    'down',
    'the suggestion left these files unsaved: file:///repo/locked.yml',
  ]);
});

test('activation paints the suggestions the server sends and registers the move', async () => {
  const painted = [];
  const notes = {};
  const commands = {};
  const disposable = { dispose() {} };
  let inlayChanges = 0;
  let inlayProvider = null;
  let suggestionsSetting = 'on';
  let stackCapacitySetting = 32;
  let configurationChanged = null;
  let documentClosed = null;
  const sent = [];
  const warnings = [];
  const vscode = {
    ...inlayVscode(),
    ...fakeVscode([recordingEditor('file:///repo/dev/mock.yml', painted)]),
    InlayHintLabelPart: inlayVscode().InlayHintLabelPart,
    InlayHint: inlayVscode().InlayHint,
    EventEmitter: class {
      constructor() { this.event = () => disposable; }
      fire() { inlayChanges += 1; }
      dispose() {}
    },
    Uri: { joinPath: (base, part) => `${base}/${part}` },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      fs: { readFile: async () => { throw new Error('none'); } },
      getConfiguration: (section) => ({
        get: (key) => {
          if (section === 'yaml-dsl-editor' && key === 'features.suggestions') return suggestionsSetting;
          if (section === 'yaml-dsl-editor' && key === 'cache.stackCapacity') return stackCapacitySetting;
          return section === 'yaml-dsl-editor' && key.startsWith('cache.') ? 32 : {};
        },
        update: async () => {},
      }),
      onDidChangeConfiguration(fn) {
        configurationChanged = fn;
        return disposable;
      },
      onDidCloseTextDocument(fn) {
        documentClosed = fn;
        return disposable;
      },
      registerTextDocumentContentProvider: () => disposable,
      createFileSystemWatcher: () => ({
        onDidChange: () => disposable,
        onDidCreate: () => disposable,
        onDidDelete: () => disposable,
        dispose() {},
      }),
      onDidOpenTextDocument: () => disposable,
      onDidChangeTextDocument(fn) {
        vscode.documentChanged = fn;
        return disposable;
      },
    },
    commands: {
      executeCommand: async () => {},
      registerCommand(name, fn) { commands[name] = fn; return disposable; },
    },
    languages: {
      setTextDocumentLanguage: async () => {},
      registerInlayHintsProvider(selector, provider) {
        inlayProvider = { selector, provider };
        return disposable;
      },
    },
  };
  const decorationTypes = [];
  vscode.window.createTextEditorDecorationType = (options) => {
    const decorationType = { options, dispose() {} };
    decorationTypes.push(decorationType);
    return decorationType;
  };
  vscode.window.onDidChangeActiveTextEditor = () => disposable;
  vscode.window.onDidChangeVisibleTextEditors = (fn) => { vscode.visibleChanged = fn; return disposable; };
  const client = {
    stop() {},
    onNotification(method, fn) { notes[method] = fn; },
    async sendNotification(method, params) { sent.push([method, params]); },
    async sendRequest() { return null; },
  };
  vscode.window.showWarningMessage = (message) => { warnings.push(message); };
  await activateWith(vscode, { subscriptions: [], extensionUri: 'mock-extension' }, () => client);
  const capacityNotes = () => sent.filter(([method]) => method === 'yaml-dsl/cacheCapacities');
  assert.deepEqual(capacityNotes(), [['yaml-dsl/cacheCapacities', { schemaCapacity: 32, stackCapacity: 32 }]]);
  const position = { line: 0, character: 6 };
  const mark = { range: { start: position, end: position }, suggestion: moveSuggestion };
  notes['yaml-dsl/suggestions']({
    stackId: '/repo/mock.yml',
    files: [{ uri: 'file:///repo/dev/mock.yml', marks: [mark] }],
  });
  const lightbulbIcon = 'mock-extension/media/suggestion-lightbulb.svg';
  const isLightbulb = (item) => item.mark.options && item.mark.options.gutterIconPath === lightbulbIcon;
  const lightbulb = painted.filter(isLightbulb).at(-1);
  assert.equal(lightbulb.mark.options.after, undefined);
  assert.equal(lightbulb.ranges.length, 1);
  const errorMark = decorationTypes.find((decorationType) => decorationType.options.color === '#f14c4c');
  assert.equal(errorMark.options.gutterIconPath, 'mock-extension/media/error-gutter-mark.svg');
  assert.deepEqual(inlayProvider.selector, { language: 'yaml-dsl' });
  assert.equal(inlayChanges, 1);
  const hints = inlayProvider.provider.provideInlayHints(documentOf('file:///repo/dev/mock.yml', ['queue:']));
  assert.equal(hints[0].label[0].value, '💡 move to common layer');
  vscode.visibleChanged();
  assert.equal(painted.filter(isLightbulb).length, 2);
  assert.equal(typeof commands[APPLY_COMMAND], 'function');
  suggestionsSetting = 'off';
  configurationChanged({ affectsConfiguration: (setting) => setting === 'other.setting' });
  assert.equal(inlayChanges, 1);
  configurationChanged({ affectsConfiguration: (setting) => setting === 'yaml-dsl-editor.features.suggestions' });
  assert.equal(inlayChanges, 2);
  assert.deepEqual(painted.filter(isLightbulb).at(-1).ranges, []);
  assert.deepEqual(inlayProvider.provider.provideInlayHints(documentOf('file:///repo/dev/mock.yml', ['queue:'])), []);
  suggestionsSetting = 'on';
  configurationChanged({ affectsConfiguration: () => true });
  assert.equal(painted.filter(isLightbulb).at(-1).ranges.length, 1);
  const edited = { languageId: 'yaml-dsl', uri: { scheme: 'file', toString: () => 'file:///repo/dev/mock.yml' } };
  const changesBefore = inlayChanges;
  vscode.documentChanged({ document: edited });
  assert.deepEqual(painted.filter(isLightbulb).at(-1).ranges, []);
  assert.deepEqual(inlayProvider.provider.provideInlayHints(documentOf('file:///repo/dev/mock.yml', ['queue:'])), []);
  assert.equal(inlayChanges, changesBefore + 2);
  vscode.documentChanged({ document: edited });
  assert.equal(inlayChanges, changesBefore + 3);
  vscode.documentChanged({ document: { languageId: 'yaml', uri: { scheme: 'file', toString: () => 'file:///x.yml' } } });
  notes['yaml-dsl/suggestions']({});
  const cacheChanged = { affectsConfiguration: (setting) => setting === 'yaml-dsl-editor.cache' };
  stackCapacitySetting = 4;
  configurationChanged(cacheChanged);
  await Promise.resolve();
  assert.deepEqual(capacityNotes().at(-1), ['yaml-dsl/cacheCapacities', { schemaCapacity: 32, stackCapacity: 4 }]);
  stackCapacitySetting = 0;
  const sentBefore = capacityNotes().length;
  configurationChanged(cacheChanged);
  await Promise.resolve();
  assert.equal(capacityNotes().length, sentBefore);
  assert.deepEqual(warnings, ['yaml-dsl-editor.cache.stackCapacity must be a whole number, 1 or more']);
  notes['yaml-dsl/suggestions']({
    stackId: '/repo/mock.yml',
    files: [{ uri: 'file:///repo/dev/mock.yml', marks: [mark] }],
  });
  assert.equal(inlayProvider.provider.provideInlayHints(documentOf('file:///repo/dev/mock.yml', ['queue:'])).length, 1);
  notes['yaml-dsl/evicted']({ stackIds: ['/repo/mock.yml'] });
  assert.deepEqual(inlayProvider.provider.provideInlayHints(documentOf('file:///repo/dev/mock.yml', ['queue:'])), []);
  documentClosed({ uri: { toString: () => 'file:///repo/dev/mock.yml' } });
  documentClosed(null);
});

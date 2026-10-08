const path = require('path');
const { parseConfig, ownsFile } = require('./config');
const { valueStarts } = require('./value-starts');
const { scanPlaceholders } = require('./placeholder-scan');
const { leadingLiteral } = require('./reference-template');
const { WHOLE_SCALAR, ANYWHERE_IN_SCALAR } = require('./reference-positions');
const {
  APPLY_COMMAND,
  paintLightbulbs,
  suggestionInlayHints,
  suggestionFileDecoration,
  applySuggestion,
} = require('./suggestion-lightbulbs');
const { createSuggestionMarksStore } = require('./suggestion-marks-store');
const { workspaceStorageNameOf } = require('./workspace-identity');
const { createSuggestionUndoSaves } = require('./suggestion-undo-saves');

const PEEK_COMMAND = 'yaml-dsl-editor.peek';
const LIGHTBULB_ICON = 'media/suggestion-lightbulb.svg';
const ERROR_GUTTER_ICON = 'media/error-gutter-mark.svg';
const INFO_GUTTER_ICON = 'media/info-gutter-mark.svg';
const SETTINGS_SECTION = 'yaml-dsl-editor';
const SUGGESTIONS_KEY = 'features.suggestions';
const SUGGESTIONS_SETTING = `${SETTINGS_SECTION}.${SUGGESTIONS_KEY}`;
const CACHE_SETTINGS = `${SETTINGS_SECTION}.cache`;
const INFO_SEVERITY = 'info';
const INFO_COLOR = '#a6abf2';
// const WARNING_COLOR = '#ece200';
const ERROR_COLOR = '#dc7975';
const CACHE_CAPACITY_KEYS = ['schemaCapacity', 'stackCapacity'];

function cacheCapacities(vscode) {
  const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const capacities = {};
  for (const key of CACHE_CAPACITY_KEYS) {
    const value = settings.get(`cache.${key}`);
    if (!Number.isInteger(value) || value < 1) {
      return { capacities: null, problem: `${CACHE_SETTINGS}.${key} must be a whole number, 1 or more` };
    }
    capacities[key] = value;
  }
  return { capacities, problem: null };
}

function changedByUndoOrRedo(vscode, event) {
  const reasons = vscode.TextDocumentChangeReason;
  return event.reason === reasons.Undo || event.reason === reasons.Redo;
}

async function sendCacheCapacities(vscode, client) {
  const { capacities, problem } = cacheCapacities(vscode);
  if (problem) {
    vscode.window.showWarningMessage(problem);
    return;
  }
  await client.sendNotification('yaml-dsl/cacheCapacities', capacities).catch(() => {});
}

function editorUriKey(vscode, uri) {
  return vscode.Uri && vscode.Uri.parse ? vscode.Uri.parse(uri).toString() : uri;
}

function suggestionsOn(vscode) {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION).get(SUGGESTIONS_KEY) !== 'off';
}

function extensionFilePath(vscode, context, fileName) {
  if (context.extensionUri && vscode.Uri && vscode.Uri.joinPath) {
    return vscode.Uri.joinPath(context.extensionUri, fileName);
  }
  return context.extensionPath ? path.join(context.extensionPath, fileName) : undefined;
}

function foldUri(vscode, stackId, overlayName) {
  return vscode.Uri.from({
    scheme: 'yaml-dsl-fold',
    path: `/${encodeURIComponent(stackId)}/${encodeURIComponent(overlayName)}`,
  });
}

function parseFoldPath(uriPath) {
  if (!uriPath || !uriPath.startsWith('/')) return null;
  const trimmed = uriPath.slice(1);
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return null;
  return {
    stackId: decodeURIComponent(trimmed.slice(0, slash)),
    overlayName: decodeURIComponent(trimmed.slice(slash + 1)),
  };
}

function visibleFoldStacks(vscode) {
  const ids = new Set();
  for (const editor of vscode.window.visibleTextEditors || []) {
    const uri = editor.document && editor.document.uri;
    if (!uri || uri.scheme !== 'yaml-dsl-fold') continue;
    const parsed = parseFoldPath(uri.path);
    if (parsed) ids.add(parsed.stackId);
  }
  return [...ids];
}

async function readConfigs(vscode) {
  const folders = vscode.workspace.workspaceFolders || [];
  const found = await Promise.all(folders.map(async (folder) => {
    const uri = vscode.Uri.joinPath(folder.uri, 'yaml-dsl.yml');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return { text: Buffer.from(bytes).toString('utf8'), dir: folder.uri.fsPath };
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

function associationPatterns(includes) {
  const patterns = [];
  const seen = new Set();
  function add(pattern) {
    if (!pattern || seen.has(pattern)) return;
    seen.add(pattern);
    patterns.push(pattern);
  }
  for (const pattern of includes) {
    add(pattern);
    const slash = pattern.lastIndexOf('/');
    const base = slash >= 0 ? pattern.slice(slash + 1) : pattern;
    if (base && !base.includes('*') && !base.includes('?')) add(base);
  }
  return patterns;
}

function fileInDir(filePath, dir) {
  const file = String(filePath).replaceAll('\\', '/');
  const root = String(dir || '').replaceAll('\\', '/').replace(/\/$/, '');
  if (!root) return false;
  return file === root || file.startsWith(`${root}/`);
}

function ownedFile(filePath, entries) {
  for (const entry of entries || []) {
    if (!fileInDir(filePath, entry.dir)) continue;
    const parsed = parseConfig(entry.text);
    if (parsed.dsls.some((dsl) => ownsFile(dsl, filePath))) return true;
  }
  return false;
}

async function listOwnedFiles(vscode, entries) {
  if (!vscode.workspace.findFiles || !vscode.RelativePattern) return [];
  const paths = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const parsed = parseConfig(entry.text);
    const folder = { uri: { fsPath: entry.dir } };
    for (const dsl of parsed.dsls) {
      for (const pattern of dsl.fileIncludes) {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, pattern),
          '**/{.git,node_modules,.terraform}/**',
        );
        for (const uri of found) {
          if (!uri || !uri.fsPath || seen.has(uri.fsPath) || !ownsFile(dsl, uri.fsPath)) continue;
          seen.add(uri.fsPath);
          paths.push(uri.fsPath);
        }
      }
    }
  }
  return paths;
}

function warmOwnedFiles(vscode, client, entries) {
  listOwnedFiles(vscode, entries).then((paths) => {
    if (!paths.length) return undefined;
    return client.sendNotification('yaml-dsl/warm', { paths });
  }).catch(() => {});
}

async function applyAssociations(vscode) {
  const cfg = vscode.workspace.getConfiguration('files');
  const current = { ...(cfg.get('associations') || {}) };
  let changed = false;
  for (const [key, value] of Object.entries(current)) {
    if (value !== 'yaml-dsl') continue;
    delete current[key];
    changed = true;
  }
  if (changed) await cfg.update('associations', current, vscode.ConfigurationTarget.Workspace);
}

async function claimOpenDocuments(vscode, entries) {
  const docs = vscode.workspace.textDocuments || [];
  await Promise.all(docs.map(async (doc) => {
    if (!doc.uri || doc.uri.scheme !== 'file') return;
    const owned = ownedFile(doc.uri.fsPath, entries);
    if (owned && doc.languageId !== 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    if (!owned && doc.languageId === 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml');
  }));
}

async function claimVisible(vscode) {
  const docs = [];
  const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (active) docs.push(active);
  for (const editor of vscode.window.visibleTextEditors || []) {
    if (editor && editor.document && !docs.includes(editor.document)) docs.push(editor.document);
  }
  await Promise.all(docs.map((doc) => claimByWalk(vscode, doc)));
}

async function claimByWalk(vscode, doc) {
  if (!doc || !doc.uri || doc.uri.scheme !== 'file' || !doc.uri.fsPath) return;
  if (doc.languageId === 'yaml-dsl') return;
  let dir = path.dirname(doc.uri.fsPath);
  while (dir && dir !== path.dirname(dir)) {
    let text = null;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath({ fsPath: dir }, 'yaml-dsl.yml'));
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      text = null;
    }
    if (text) {
      if (ownedFile(doc.uri.fsPath, [{ text, dir }])) {
        await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
      }
      return;
    }
    dir = path.dirname(dir);
  }
}

async function closeEvicted(vscode, stackIds) {
  const groups = vscode.window.tabGroups;
  if (!groups) return;
  const doomed = new Set(stackIds || []);
  const tabs = [];
  for (const group of groups.all || []) {
    for (const tab of group.tabs || []) {
      const uri = tab.input && tab.input.uri;
      if (!uri || uri.scheme !== 'yaml-dsl-fold') continue;
      const parsed = parseFoldPath(uri.path || '');
      if (parsed && doomed.has(parsed.stackId)) tabs.push(tab);
    }
  }
  if (tabs.length > 0) await groups.close(tabs);
}

let peekedPath = null;

async function peekFold(vscode, editor, uri) {
  if (vscode.workspace.openTextDocument) {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc && doc.languageId !== 'yaml-dsl') {
      await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    }
  }
  if (!vscode.commands || !vscode.commands.executeCommand) return;
  const position = editor.selection && editor.selection.active
    ? editor.selection.active
    : new vscode.Position(0, 0);
  const origin = new vscode.Position(0, 0);
  await vscode.commands.executeCommand(
    'editor.action.peekLocations',
    editor.document.uri,
    position,
    [new vscode.Location(uri, new vscode.Range(origin, origin))],
    'peek',
  );
}

async function revealFolds(vscode, client, editor) {
  if (!editor || !editor.document) return;
  if (editor.document.languageId !== 'yaml-dsl') return;
  if (editor.document.uri.scheme !== 'file') return;
  const filePath = editor.document.uri.fsPath;
  if (filePath === peekedPath) return;
  let info;
  try {
    info = await client.sendRequest('yaml-dsl/foldsFor', { path: filePath });
  } catch {
    return;
  }
  if (!info || !info.stackId || !info.overlayNames || info.overlayNames.length !== 1) return;
  try {
    await peekFold(vscode, editor, foldUri(vscode, info.stackId, info.overlayNames[0]));
    peekedPath = filePath;
  } catch {
    return;
  }
}

let publishing = false;

async function publishEditorState(vscode, client, reveal) {
  if (publishing) return;
  publishing = true;
  try {
    const editor = vscode.window.activeTextEditor;
    const activePath = editor && editor.document && editor.document.uri && editor.document.uri.fsPath;
    if (activePath !== peekedPath) peekedPath = null;
    const visible = visibleFoldStacks(vscode);
    try {
      const owned = editor
        && editor.document
        && editor.document.uri.scheme === 'file'
        && editor.document.languageId === 'yaml-dsl';
      await client.sendNotification('yaml-dsl/active', {
        path: owned ? editor.document.uri.fsPath : null,
      });
      await client.sendNotification('yaml-dsl/visibleFolds', { stackIds: visible });
    } catch {
      return;
    }
  } finally {
    publishing = false;
  }
}

async function activateWith(vscode, context, startClient) {
  const listed = readConfigs(vscode);
  await claimVisible(vscode);
  let currentEntries = await listed;
  await claimOpenDocuments(vscode, currentEntries);
  const client = startClient(context, () => currentEntries);
  const subscriptions = context.subscriptions;
  subscriptions.push({ dispose: () => client.stop() });
  const referenceMarks = vscode.window.createTextEditorDecorationType
    ? {
      local: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' }),
      external: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline wavy' }),
      error: vscode.window.createTextEditorDecorationType({
        textDecoration: `underline wavy ${ERROR_COLOR}`,
        color: ERROR_COLOR,
        gutterIconPath: extensionFilePath(vscode, context, ERROR_GUTTER_ICON),
        gutterIconSize: 'contain',
      }),
      info: vscode.window.createTextEditorDecorationType({
        textDecoration: `underline wavy ${INFO_COLOR}`,
        gutterIconPath: extensionFilePath(vscode, context, INFO_GUTTER_ICON),
        gutterIconSize: 'contain',
      }),
      unclassified: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' }),
    }
    : null;
  if (referenceMarks) subscriptions.push(...Object.values(referenceMarks));
  const lightbulbMark = vscode.window.createTextEditorDecorationType
    ? vscode.window.createTextEditorDecorationType({
      gutterIconPath: extensionFilePath(vscode, context, LIGHTBULB_ICON),
      gutterIconSize: 'contain',
    })
    : null;
  if (lightbulbMark) subscriptions.push(lightbulbMark);
  const workspaceStorageName = workspaceStorageNameOf(vscode.workspace);
  const marksStore = createSuggestionMarksStore({
    storageFolder: context.globalStorageUri && workspaceStorageName
      ? vscode.Uri.joinPath(context.globalStorageUri, workspaceStorageName)
      : null,
    fileSystem: vscode.workspace.fs,
    joinPath: (folder, name) => vscode.Uri.joinPath(folder, name),
    parseUri: (uri) => vscode.Uri.parse(uri),
    timerFunctions: { setTimeout, clearTimeout },
  });
  subscriptions.push({ dispose: () => { marksStore.flush(); } });
  const undoSaves = createSuggestionUndoSaves();
  const shownMarksByUri = () => (suggestionsOn(vscode) ? marksStore.marksByUri : new Map());
  const inlayHintsChanged = new vscode.EventEmitter();
  subscriptions.push(inlayHintsChanged);
  const fileDecorationsChanged = new vscode.EventEmitter();
  subscriptions.push(fileDecorationsChanged);
  const repaintLightbulbs = () => {
    if (lightbulbMark) paintLightbulbs(vscode, lightbulbMark, shownMarksByUri());
  };
  const redrawSuggestions = () => {
    repaintLightbulbs();
    inlayHintsChanged.fire();
    fileDecorationsChanged.fire(undefined);
  };
  if (vscode.languages.registerInlayHintsProvider) {
    subscriptions.push(vscode.languages.registerInlayHintsProvider({ language: 'yaml-dsl' }, {
      onDidChangeInlayHints: inlayHintsChanged.event,
      provideInlayHints: (document) => suggestionInlayHints(vscode, shownMarksByUri(), document),
    }));
  }
  if (vscode.window.registerFileDecorationProvider) {
    subscriptions.push(vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: fileDecorationsChanged.event,
      provideFileDecoration: (uri) => suggestionFileDecoration(vscode, shownMarksByUri(), uri),
    }));
  }
  if (vscode.workspace.onDidChangeConfiguration) {
    subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SUGGESTIONS_SETTING)) redrawSuggestions();
      if (event.affectsConfiguration(CACHE_SETTINGS)) sendCacheCapacities(vscode, client);
    }));
  }
  if (vscode.workspace.onDidCloseTextDocument) {
    subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc && doc.uri) paintGenerations.delete(doc.uri.toString());
    }));
  }
  client.onNotification('yaml-dsl/suggestions', (params) => {
    const files = (params.files || []).map((file) => ({
      uri: editorUriKey(vscode, file.uri),
      textHash: file.textHash,
      marks: file.marks || [],
    }));
    marksStore.replaceStack(params.stackId, files);
    redrawSuggestions();
  });
  const refreshSuggestionsOf = (uris) => {
    if (uris.length === 0) return;
    const paths = uris.map((uri) => vscode.Uri.parse(uri).fsPath);
    client.sendNotification('yaml-dsl/refreshSuggestions', { paths }).catch(() => {});
  };
  const savedMarksLoad = marksStore.load().then((result) => {
    if (result.loaded) redrawSuggestions();
    return result;
  });
  if (vscode.workspace.createFileSystemWatcher) {
    const layerFiles = vscode.workspace.createFileSystemWatcher('**/*');
    const fileChanged = async (uri) => {
      const key = uri.toString();
      if (!(await marksStore.checkUri(key))) return;
      redrawSuggestions();
      refreshSuggestionsOf([key]);
    };
    subscriptions.push(
      layerFiles,
      layerFiles.onDidChange(fileChanged),
      layerFiles.onDidCreate(fileChanged),
      layerFiles.onDidDelete((uri) => { if (marksStore.dropUri(uri.toString())) redrawSuggestions(); }),
    );
  }
  client.onNotification('yaml-dsl/reanalyzed', (params) => {
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries, params.uris || []);
  });
  client.onNotification('yaml-dsl/evicted', (params) => {
    closeEvicted(vscode, params.stackIds || []);
  });
  const emitter = new vscode.EventEmitter();
  subscriptions.push(emitter);
  const provider = vscode.workspace.registerTextDocumentContentProvider('yaml-dsl-fold', {
    onDidChange: emitter.event,
    provideTextDocumentContent(uri) {
      const parsed = parseFoldPath(uri.path);
      if (!parsed) return '';
      return client.sendRequest('yaml-dsl/fold', parsed);
    },
  });
  subscriptions.push(provider);

  async function reloadConfig() {
    currentEntries = await readConfigs(vscode);
    await claimOpenDocuments(vscode, currentEntries);
    try {
      await client.sendNotification('yaml-dsl/config', { entries: currentEntries });
    } catch {
      // The client may already be stopping.
    }
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
    applyAssociations(vscode);
    warmOwnedFiles(vscode, client, currentEntries);
  }

  if (vscode.commands && vscode.commands.registerCommand) {
    subscriptions.push(vscode.commands.registerCommand(PEEK_COMMAND, async (arg) => {
      if (!arg || !arg.uri) return undefined;
      try {
        await vscode.commands.executeCommand('editor.action.closeReferenceSearch');
      } catch {
        // No peek is open.
      }
      const range = new vscode.Range(arg.startLine, arg.startCharacter, arg.endLine, arg.endCharacter);
      const target = vscode.Uri.parse(arg.uri);
      const doc = vscode.workspace.openTextDocument
        ? await vscode.workspace.openTextDocument(target)
        : target;
      if (doc && doc.languageId && doc.languageId !== 'yaml-dsl' && doc.uri && ownedFile(doc.uri.fsPath, currentEntries)) {
        await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
      }
      return vscode.window.showTextDocument(doc, { selection: range, preview: true });
    }));
    subscriptions.push(vscode.commands.registerCommand(
      APPLY_COMMAND,
      (argument) => applySuggestion(vscode, client, argument, undoSaves),
    ));
  }

  const state = publishEditorState(vscode, client, true);
  await sendCacheCapacities(vscode, client);
  await client.sendNotification('yaml-dsl/config', { entries: currentEntries }).catch(() => {});
  savedMarksLoad.then(({ staleUris }) => refreshSuggestionsOf(staleUris));
  warmOwnedFiles(vscode, client, currentEntries);
  const links = referenceMarks ? paintUnderlines(vscode, client, referenceMarks, currentEntries) : null;
  const settings = applyAssociations(vscode);
  if (links) await links;
  await state;
  await settings;

  const watcher = vscode.workspace.createFileSystemWatcher('**/yaml-dsl.yml');
  const reload = () => { reloadConfig(); };
  subscriptions.push(watcher.onDidChange(reload));
  subscriptions.push(watcher.onDidCreate(reload));
  subscriptions.push(watcher.onDidDelete(reload));
  subscriptions.push(watcher);
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reload));
  }
  subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc && doc.uri && doc.uri.scheme === 'yaml-dsl-fold' && doc.languageId !== 'yaml-dsl') {
      vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    }
    claimOpenDocuments(vscode, currentEntries);
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === 'yaml-dsl' && event.document.uri.scheme === 'file') {
      emitter.fire(event.document.uri);
      if (marksStore.clearUri(event.document.uri.toString())) redrawSuggestions();
    }
    undoSaves.documentChanged(event.document, changedByUndoOrRedo(vscode, event));
  }));
  subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    publishEditorState(vscode, client, true);
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
  }));
  subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    publishEditorState(vscode, client, false);
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
    repaintLightbulbs();
  }));
  return { client, reloadConfig };
}

function makeRange(vscode, startLine, startCharacter, endLine, endCharacter) {
  if (vscode.Range) return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function owningDsl(entries, filePath) {
  for (const entry of entries || []) {
    if (!fileInDir(filePath, entry.dir)) continue;
    const owner = parseConfig(entry.text).dsls.find((dsl) => ownsFile(dsl, filePath));
    if (owner) return owner;
  }
  return null;
}

function namesBuiltins(rule, dsl) {
  const scope = dsl.scopes ? dsl.scopes[rule.scopeName] : null;
  return Boolean(scope && scope.builtinNames.length > 0);
}

function valueEnd(line, valueStart) {
  const inFlow = /[[{,]\s*$/.test(line.slice(0, valueStart));
  const stop = line.slice(valueStart).search(inFlow ? /\s#|[,\]}]/ : /\s#/);
  const end = stop < 0 ? line.length : valueStart + stop;
  return valueStart + line.slice(valueStart, end).trimEnd().length;
}

function rangesInText(vscode, text, dsl) {
  if (!dsl) return [];
  const rules = dsl.references || [];
  const ranges = [];
  String(text || '').split('\n').forEach((line, lineNo) => {
    const starts = valueStarts(line);
    for (const placeholder of scanPlaceholders(line, dsl.placeholder, rules)) {
      if (!placeholder.reference || namesBuiltins(placeholder.reference.rule, dsl)) continue;
      if (!placeholder.reference.rule.positions.includes(placeholder.position)) continue;
      ranges.push(makeRange(vscode, lineNo, placeholder.bodyStart, lineNo, placeholder.bodyEnd));
    }
    for (const rule of rules) {
      if (namesBuiltins(rule, dsl)) continue;
      if (rule.positions.includes(ANYWHERE_IN_SCALAR)) {
        for (const match of line.matchAll(new RegExp(rule.pattern, 'g'))) {
          if (match[0].length === 0) continue;
          ranges.push(makeRange(vscode, lineNo, match.index, lineNo, match.index + match[0].length));
        }
        continue;
      }
      if (!rule.positions.includes(WHOLE_SCALAR)) continue;
      const anchored = new RegExp(`^(?:${rule.pattern.replace(/^\^/, '')})`);
      for (const valueStart of starts) {
        const match = line.slice(valueStart).match(anchored);
        if (match && match[0].length > 0) {
          const end = rule.textAfterNameAllowed ? valueEnd(line, valueStart) : valueStart + match[0].length;
          ranges.push(makeRange(vscode, lineNo, valueStart, lineNo, end));
        }
      }
    }
  });
  return ranges;
}

const paintGenerations = new Map();
const classifiedEditors = new WeakSet();

function editorRange(vscode, range) {
  return makeRange(vscode, range.start.line, range.start.character, range.end.line, range.end.character);
}

function clearMarks(editor, referenceMarks) {
  for (const mark of Object.values(referenceMarks)) editor.setDecorations(mark, []);
}

function isConfigFile(doc, entries) {
  const fsPath = doc && doc.uri && doc.uri.fsPath;
  if (!fsPath || path.basename(fsPath) !== 'yaml-dsl.yml') return false;
  return (entries || []).some((entry) => path.join(entry.dir, 'yaml-dsl.yml') === fsPath);
}

function problemDecoration(vscode, doc, problem) {
  const { start, end } = problem.range;
  const wholeLine = start.line === end.line && start.character === end.character
    && typeof doc.lineAt === 'function' && start.line < doc.lineCount;
  const range = wholeLine ? doc.lineAt(start.line).range : editorRange(vscode, problem.range);
  return { range, hoverMessage: problem.message };
}

async function paintUnderlines(vscode, client, referenceMarks, entries, onlyUris) {
  const editors = (vscode.window && vscode.window.visibleTextEditors) || [];
  const requestedUris = onlyUris ? new Set(onlyUris) : null;
  for (const editor of editors) {
    const doc = editor && editor.document;
    if (requestedUris && !(doc && doc.uri && requestedUris.has(doc.uri.toString()))) continue;
    const configFile = isConfigFile(doc, entries);
    if (!doc || (doc.languageId !== 'yaml-dsl' && !configFile) || !editor.setDecorations) {
      if (editor && editor.setDecorations) clearMarks(editor, referenceMarks);
      continue;
    }
    if (!configFile && !classifiedEditors.has(editor) && doc.uri.fsPath && typeof doc.getText === 'function') {
      clearMarks(editor, referenceMarks);
      const dsl = owningDsl(entries, doc.uri.fsPath);
      editor.setDecorations(referenceMarks.unclassified, rangesInText(vscode, doc.getText(), dsl));
    }
    const documentKey = doc.uri.toString();
    const paintGeneration = (paintGenerations.get(documentKey) || 0) + 1;
    paintGenerations.set(documentKey, paintGeneration);
    let answer = null;
    try {
      answer = await client.sendRequest('yaml-dsl/decorations', { uri: documentKey });
    } catch {
      answer = null;
    }
    if (paintGenerations.get(documentKey) !== paintGeneration) continue;
    if (!answer || typeof answer !== 'object') continue;
    const problems = answer.problems || [];
    const errorMarks = problems
      .filter((problem) => problem.severity !== INFO_SEVERITY)
      .map((problem) => problemDecoration(vscode, doc, problem));
    const infoMarks = problems
      .filter((problem) => problem.severity === INFO_SEVERITY)
      .map((problem) => problemDecoration(vscode, doc, problem));
    if (Array.isArray(answer.references)) {
      const rangesByClass = { local: [], external: [], unclassified: [] };
      for (const reference of answer.references) {
        const range = editorRange(vscode, reference.range);
        if (reference.kind === 'error') {
          errorMarks.push({ range });
          continue;
        }
        if (reference.kind !== 'local' && reference.kind !== 'external') continue;
        rangesByClass[reference.kind].push(range);
      }
      for (const [referenceClass, classRanges] of Object.entries(rangesByClass)) {
        editor.setDecorations(referenceMarks[referenceClass], classRanges);
      }
      classifiedEditors.add(editor);
    }
    editor.setDecorations(referenceMarks.error, errorMarks);
    editor.setDecorations(referenceMarks.info, infoMarks);
  }
}

const HOVER_PEEK_DELAY = 1000;

function waitForHover(ms, token) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    if (token && token.onCancellationRequested) {
      token.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve(true);
      });
    }
  });
}

function hoverText(hover) {
  if (!hover || hover.contents == null) return '';
  const contents = hover.contents;
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((item) => (typeof item === 'string' ? item : (item.value || ''))).join('\n');
  }
  return contents.value || '';
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function coloredSpans(line, dsl) {
  const spans = new Map();
  if (!dsl) return spans;
  const rules = dsl.references || [];
  for (const placeholder of scanPlaceholders(line, dsl.placeholder, rules)) {
    spans.set(placeholder.start, { end: placeholder.end, color: '#82D2CE' });
  }
  for (const rule of rules) {
    const literalText = leadingLiteral(rule).trimEnd();
    if (!literalText) continue;
    const starts = [
      ...(rule.positions.includes(WHOLE_SCALAR) ? valueStarts(line) : []),
      ...(rule.positions.includes(ANYWHERE_IN_SCALAR)
        ? [...line.matchAll(new RegExp(rule.pattern, 'g'))].map((match) => match.index)
        : []),
    ];
    for (const start of starts) {
      if (spans.has(start) || !line.startsWith(literalText, start)) continue;
      spans.set(start, { end: start + literalText.length, color: '#efb080' });
    }
  }
  return spans;
}

function colorYamlLine(line, dsl) {
  const spans = coloredSpans(line, dsl);
  let out = '';
  let i = 0;
  while (i < line.length) {
    const span = spans.get(i);
    if (span) {
      out += `<span style="color:${span.color};">${escapeHtml(line.slice(i, span.end))}</span>`;
      i = span.end;
      continue;
    }
    if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      out += `<span style="color:#6A9955;">${escapeHtml(line.slice(i))}</span>`;
      break;
    }
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        j += line[j] === '\\' ? 2 : 1;
      }
      if (j < line.length) j += 1;
      out += `<span style="color:#e394dc;">${escapeHtml(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    const key = line.slice(i).match(/^([A-Za-z_][\w.-]*)(\s*:)/);
    if (key && (i === 0 || /\s/.test(line[i - 1]))) {
      out += `<span style="color:#87C3FF;">${escapeHtml(key[1])}</span>${escapeHtml(key[2])}`;
      i += key[0].length;
      continue;
    }
    out += escapeHtml(line[i]);
    i += 1;
  }
  return out;
}

function hoverBody(code, dsl) {
  // One line. A blank line ends an HTML block, and a code fence is a separate clipped box.
  const lines = code.split('\n').map((line) => {
    if (line === '') return '&nbsp;';
    return colorYamlLine(line.replace(/ /g, '\u00a0'), dsl);
  });
  return `<div>${lines.join('<br>')}</div>`;
}

function openableLocation(vscode, hover, entries) {
  if (!vscode.MarkdownString || !vscode.Hover) return hover;
  const text = hoverText(hover);
  const match = text.match(/\[([^\]]+)\]\((file:\/\/[^)\s]+)#L(\d+)\)/);
  if (!match) return hover;
  const line = Number(match[3]) - 1;
  const arg = {
    uri: match[2],
    startLine: line,
    startCharacter: 0,
    endLine: line,
    endCharacter: 0,
  };
  const href = `command:${PEEK_COMMAND}?${encodeURIComponent(JSON.stringify(arg))}`;
  const label = escapeHtml(match[1]);
  const fenced = text.slice(match.index + match[0].length).match(/```yaml-dsl\n([\s\S]*?)\n```/);
  const declaringPath = decodeURIComponent(match[2].replace(/^file:\/\//, ''));
  const body = fenced ? hoverBody(fenced[1], owningDsl(entries, declaringPath)) : '';
  const md = new vscode.MarkdownString();
  md.supportHtml = true;
  md.isTrusted = { enabledCommands: [PEEK_COMMAND] };
  md.appendMarkdown(`<div><a href="${href}"><code><u>${label}</u></code></a>${body}</div>`);
  return new vscode.Hover(md, hover.range);
}

function editorMiddleware(vscode, configEntries = () => []) {
  return {
    async provideHover(document, position, token, next) {
      if (token && !token.isCancellationRequested) {
        const cancelled = await waitForHover(HOVER_PEEK_DELAY, token);
        if (cancelled || token.isCancellationRequested) return null;
      }
      return openableLocation(vscode, await next(document, position, token), configEntries());
    },
    async provideDocumentLinks(document, token, next) {
      // Keep the file target. A command target makes the editor add "Execute command".
      return next(document, token);
    },
  };
}

module.exports = {
  activateWith,
  foldUri,
  parseFoldPath,
  associationPatterns,
  visibleFoldStacks,
  readConfigs,
  applyAssociations,
  claimOpenDocuments,
  ownedFile,
  closeEvicted,
  revealFolds,
  publishEditorState,
  editorMiddleware,
  paintUnderlines,
};

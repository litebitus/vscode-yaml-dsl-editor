const os = require('os');
const path = require('path');
const { parseConfig, claimFile, configRootRelative } = require('./config');
const { createConfigIndex } = require('./config-index');
const { concernCommonLayerGlobs } = require('./common-layer-names');
const {
  fileAssociationsOf,
  withFileAssociations,
  withAddedFileAssociations,
  sameAssociations,
} = require('./file-associations');
const { OVERLAY_DIFF_SCHEME, createOverlayDiffViews } = require('./overlay-diff-view');
const { valueStarts, openingQuoteBefore } = require('./value-starts');
const { scanPlaceholders } = require('./placeholder-scan');
const { leadingLiteral } = require('./reference-template');
const { WHOLE_SCALAR, ANYWHERE_IN_SCALAR } = require('./reference-positions');
const {
  APPLY_COMMAND,
  SCOPE_BORDER_WIDTHS,
  paintSuggestionMarks,
  paintScopeBorders,
  suggestionInlayHints,
  suggestionFileDecoration,
  suggestionFileUrisOf,
  suggestionKindOf,
  applySuggestion,
} = require('./suggestion-marks');
const { createSuggestionMarksStore } = require('./suggestion-marks-store');
const { warningFileDecoration } = require('./warning-files');
const { validatorFileDecoration } = require('./validator-files');
const { withAncestorFolders, explorerUriSets } = require('./explorer-folders');
const { fillRequiredFieldsAfterEnter } = require('./required-fields-fill');
const {
  SETTINGS_SECTION,
  featureSettingsOf,
  forgetFeatureSettings,
  featureSettingsAffected,
} = require('./feature-settings');
const { extensionBuildHashOf } = require('./extension-build');
const { workspaceStorageNameOf } = require('./workspace-identity');
const { OUTPUT_CHANNEL_NAME, createActivityLog } = require('./activity-log');
const { createSuggestionUndoSaves } = require('./suggestion-undo-saves');
const { createInlayHintRegistration } = require('./inlay-hint-registration');
const { SHOW_DECLARATIONS_COMMAND, createDeclarationsPopup } = require('./declarations-popup');
const { PROBLEM_KINDS } = require('./problem-kinds');
const { hoverHeading, markdownWithoutHtml } = require('./hover-heading');
const {
  THEME_SETTING_KEY,
  THEME_ROLES,
  themeColorId,
  themeColorVariable,
  gutterMarkPath,
  activeThemeOf,
} = require('./themes');

const PEEK_COMMAND = 'yaml-dsl-editor.peek';
const ACCEPT_LONE_SUGGESTION_COMMAND = 'yaml-dsl-editor.acceptLoneSuggestion';
const ACCEPT_SELECTED_SUGGESTION_COMMAND = 'acceptSelectedSuggestion';
const TOGGLE_THEME_COMMAND = 'yaml-dsl-editor.toggleTheme';
const TOGGLE_EDITOR_THEME_COMMAND = 'workbench.action.toggleLightDarkThemes';
const CACHE_SETTINGS = `${SETTINGS_SECTION}.cache`;
const THEME_SETTING = `${SETTINGS_SECTION}.${THEME_SETTING_KEY}`;
const INFO_SEVERITY = 'info';
const WARNING_SEVERITY = 'warning';
const VALIDATION_ERRORS_TITLE = 'validation errors';
const CACHE_CAPACITY_KEYS = ['schemaCapacity', 'stackCapacity'];
const BUILD_HASH_SHOWN_LENGTH = 12;

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

function sendTheme(client, theme) {
  return client.sendNotification('yaml-dsl/theme', { theme }).catch(() => {});
}

async function toggleTheme(vscode) {
  await vscode.commands.executeCommand(TOGGLE_EDITOR_THEME_COMMAND);
  const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  await settings.update(THEME_SETTING_KEY, undefined, vscode.ConfigurationTarget.Global);
}

function editorUriKey(vscode, uri) {
  return vscode.Uri && vscode.Uri.parse ? vscode.Uri.parse(uri).toString() : uri;
}

function extensionFilePath(vscode, context, fileName) {
  if (context.extensionUri && vscode.Uri && vscode.Uri.joinPath) {
    return vscode.Uri.joinPath(context.extensionUri, fileName);
  }
  return context.extensionPath ? path.join(context.extensionPath, fileName) : undefined;
}

function themedProblemMarkTypes(vscode, context, theme) {
  const decorationType = (options) => vscode.window.createTextEditorDecorationType(options);
  const colorOf = (role) => themeColorVariable(theme, role);
  const gutterMarkOf = (mark) => ({
    gutterIconPath: extensionFilePath(vscode, context, gutterMarkPath(theme, mark)),
    gutterIconSize: 'contain',
  });
  return {
    error: decorationType({
      textDecoration: `underline wavy ${colorOf(THEME_ROLES.error)}`,
      color: colorOf(THEME_ROLES.error),
      ...gutterMarkOf('error'),
    }),
    warning: decorationType(gutterMarkOf('warning')),
    info: decorationType({ textDecoration: `underline wavy ${colorOf(THEME_ROLES.info)}`, ...gutterMarkOf('info') }),
    deprecated: decorationType({ textDecoration: `line-through ${colorOf(THEME_ROLES.warning)}` }),
    warningUnderline: decorationType({ textDecoration: `underline wavy ${colorOf(THEME_ROLES.warning)}` }),
  };
}

function scopeBorderTypesOf(vscode, borderColor) {
  return Object.fromEntries(Object.entries(SCOPE_BORDER_WIDTHS)
    .map(([part, borderWidth]) => [part, vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth,
      borderColor,
    })]));
}

function themedSuggestionGutterMarkTypes(vscode, context, theme) {
  const gutterMarkOf = (mark) => vscode.window.createTextEditorDecorationType({
    gutterIconPath: extensionFilePath(vscode, context, gutterMarkPath(theme, mark)),
    gutterIconSize: 'contain',
  });
  return { suggestion: gutterMarkOf('suggestion'), potentialMove: gutterMarkOf('info') };
}

function themedScopeBorderTypes(vscode, theme) {
  return {
    suggestion: scopeBorderTypesOf(vscode, themeColorVariable(theme, THEME_ROLES.suggestion)),
    potentialMove: scopeBorderTypesOf(vscode, themeColorVariable(theme, THEME_ROLES.info)),
  };
}

function disposeDecorationTypes(types) {
  for (const type of Object.values(types)) {
    if (typeof type.dispose === 'function') type.dispose();
    else disposeDecorationTypes(type);
  }
}

function swapDecorationTypes(holder, freshTypes) {
  disposeDecorationTypes(Object.fromEntries(Object.keys(freshTypes).map((key) => [key, holder[key]])));
  Object.assign(holder, freshTypes);
}

function foldUri(vscode, stackId, overlayName, overlayLabel = overlayName) {
  return vscode.Uri.from({
    scheme: 'yaml-dsl-fold',
    path: `/${encodeURIComponent(stackId)}/${encodeURIComponent(overlayName)}/${overlayLabel}`,
  });
}

function parseFoldPath(uriPath) {
  if (!uriPath || !uriPath.startsWith('/')) return null;
  const [stackPart, overlayPart] = uriPath.slice(1).split('/');
  if (!stackPart || !overlayPart) return null;
  return { stackId: decodeURIComponent(stackPart), overlayName: decodeURIComponent(overlayPart) };
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

const PARSED_CONFIGS_CAPACITY = 32;
const parsedConfigsByText = new Map();

function parsedConfigOf(text) {
  if (parsedConfigsByText.has(text)) return parsedConfigsByText.get(text);
  const parsed = parseConfig(text);
  parsedConfigsByText.set(text, parsed);
  if (parsedConfigsByText.size > PARSED_CONFIGS_CAPACITY) {
    parsedConfigsByText.delete(parsedConfigsByText.keys().next().value);
  }
  return parsed;
}

function ownedFilePatterns(vscode, entries) {
  if (!vscode.RelativePattern) return [];
  return (entries || []).flatMap((entry) => parsedConfigOf(entry.text).dsls
    .flatMap((dsl) => [...dsl.fileIncludes, ...concernCommonLayerGlobs(dsl.layers)]
      .map((pattern) => new vscode.RelativePattern(entry.dir, configRootRelative(pattern) ?? pattern))));
}

const dslsByEntries = new WeakMap();

function dslsOf(entries) {
  if (!dslsByEntries.has(entries)) {
    dslsByEntries.set(entries, entries.flatMap((entry) => parsedConfigOf(entry.text).dsls
      .map((dsl) => ({ ...dsl, dir: entry.dir }))));
  }
  return dslsByEntries.get(entries);
}

function ownedFile(filePath, entries) {
  return claimFile(filePath, dslsOf(entries || [])).status !== 'none';
}

function owningDsl(entries, filePath) {
  const claim = claimFile(filePath, dslsOf(entries || []));
  return claim.status === 'one' ? claim.dsl : null;
}


function workspaceSettingsFileOf(vscode) {
  const { workspaceFile, workspaceFolders } = vscode.workspace;
  if (workspaceFile) return workspaceFile;
  if (!workspaceFolders || workspaceFolders.length !== 1) return null;
  return vscode.Uri.joinPath(workspaceFolders[0].uri, '.vscode', 'settings.json');
}

async function workspaceSettingsFileExists(vscode) {
  const settingsFile = workspaceSettingsFileOf(vscode);
  if (!settingsFile) return false;
  try {
    await vscode.workspace.fs.stat(settingsFile);
    return true;
  } catch {
    return false;
  }
}

async function applyAssociations(vscode, log, entries, allConfigsListed) {
  if (!(await workspaceSettingsFileExists(vscode))) {
    log.info('left files.associations unwritten: the workspace has no settings file');
    return;
  }
  const filesSettings = vscode.workspace.getConfiguration('files');
  const inspected = filesSettings.inspect('associations');
  const current = inspected.workspaceValue || {};
  const settings = { workspaceValue: current, userValue: inspected.globalValue, homeFolder: os.homedir() };
  const owned = fileAssociationsOf(dslsOf(entries || []));
  const updated = allConfigsListed
    ? withFileAssociations(settings, owned)
    : withAddedFileAssociations(settings, owned);
  if (sameAssociations(current, updated)) return;
  const associations = Object.keys(updated).length > 0 ? updated : undefined;
  await filesSettings.update('associations', associations, vscode.ConfigurationTarget.Workspace);
}

function createDslFileAssociator(vscode, log) {
  let associating = Promise.resolve();
  return (entries, allConfigsListed) => {
    associating = associating.then(() => log.step(
      'associating DSL files with YAML DSL',
      () => applyAssociations(vscode, log, entries, allConfigsListed),
    ));
    return associating;
  };
}

async function claimDocument(vscode, doc, entries) {
  if (!doc || !doc.uri || doc.uri.scheme !== 'file') return;
  const owned = ownedFile(doc.uri.fsPath, entries);
  if (owned && doc.languageId !== 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
  if (!owned && doc.languageId === 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml');
}

async function claimOpenDocuments(vscode, entries) {
  await Promise.all((vscode.workspace.textDocuments || []).map((doc) => claimDocument(vscode, doc, entries)));
}

async function claimWithConfigsAbove(vscode, configIndex, doc) {
  const learned = doc && doc.uri && doc.uri.scheme === 'file' && doc.uri.fsPath
    ? await configIndex.learnConfigsAbove(doc.uri.fsPath)
    : false;
  await claimDocument(vscode, doc, configIndex.entries());
  return learned;
}

async function claimVisible(vscode, configIndex) {
  const docs = [];
  const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  if (active) docs.push(active);
  for (const editor of vscode.window.visibleTextEditors || []) {
    if (editor && editor.document && !docs.includes(editor.document)) docs.push(editor.document);
  }
  await Promise.all(docs.map((doc) => claimWithConfigsAbove(vscode, configIndex, doc)));
}

async function claimOpenDocumentsWithConfigsAbove(vscode, configIndex) {
  const docs = vscode.workspace.textDocuments || [];
  await Promise.all(docs.map((doc) => claimWithConfigsAbove(vscode, configIndex, doc)));
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

function tabUriOf(tab) {
  return tab && tab.input && tab.input.uri ? tab.input.uri : null;
}

function reopenedUris(openedTabs, releasedUris) {
  const keys = (openedTabs || []).map(tabUriOf).filter(Boolean).map((uri) => uri.toString());
  return [...new Set(keys.filter((key) => releasedUris.has(key)))];
}

function lastTabClosedUris(vscode, closedTabs) {
  const openTabUris = new Set((vscode.window.tabGroups.all || [])
    .flatMap((group) => group.tabs || [])
    .map(tabUriOf)
    .filter(Boolean)
    .map((uri) => uri.toString()));
  const closedUris = new Set();
  for (const uri of (closedTabs || []).map(tabUriOf)) {
    const key = uri ? uri.toString() : null;
    if (!uri || uri.scheme !== 'file' || openTabUris.has(key)) continue;
    const heldDocument = (vscode.workspace.textDocuments || []).find((doc) => doc.uri.toString() === key);
    if (heldDocument && !heldDocument.isDirty && heldDocument.languageId === 'yaml-dsl') closedUris.add(key);
  }
  return [...closedUris];
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
    const overlayLabels = info.overlayLabels || info.overlayNames;
    await peekFold(vscode, editor, foldUri(vscode, info.stackId, info.overlayNames[0], overlayLabels[0]));
    peekedPath = filePath;
  } catch {
    return;
  }
}

let editorStatePublishing = null;
let editorStateChangedWhilePublishing = false;

async function publishLatestEditorState(vscode, client) {
  const editor = vscode.window.activeTextEditor;
  const activePath = editor && editor.document && editor.document.uri && editor.document.uri.fsPath;
  if (activePath !== peekedPath) peekedPath = null;
  const visible = visibleFoldStacks(vscode);
  const onDisk = editor && editor.document && editor.document.uri.scheme === 'file';
  try {
    await client.sendNotification('yaml-dsl/active', { path: onDisk ? editor.document.uri.fsPath : null });
    await client.sendNotification('yaml-dsl/visibleFolds', { stackIds: visible });
  } catch {
    editorStateChangedWhilePublishing = false;
  }
}

function publishEditorState(vscode, client) {
  if (editorStatePublishing) {
    editorStateChangedWhilePublishing = true;
    return editorStatePublishing;
  }
  editorStatePublishing = (async () => {
    do {
      editorStateChangedWhilePublishing = false;
      await publishLatestEditorState(vscode, client);
    } while (editorStateChangedWhilePublishing);
  })().finally(() => { editorStatePublishing = null; });
  return editorStatePublishing;
}

async function activateWith(
  vscode,
  context,
  startClient,
  readBuildHash = () => extensionBuildHashOf(context.extensionPath),
) {
  const subscriptions = context.subscriptions;
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  subscriptions.push(outputChannel);
  const log = createActivityLog(outputChannel);
  activityLog = log;
  const configIndex = createConfigIndex(vscode);
  let allConfigsListed = false;
  const associateDslFiles = createDslFileAssociator(vscode, log);
  await log.step('reading the workspace folders\' DSL configs', () => configIndex.readWorkspaceFolderConfigs());
  const associated = associateDslFiles(configIndex.entries(), allConfigsListed);
  const listed = log.step('listing the workspace\'s DSL configs', () => configIndex.readListedConfigs());
  await log.step('claiming visible files', () => claimVisible(vscode, configIndex));
  await log.step('claiming open files', () => claimOpenDocumentsWithConfigsAbove(vscode, configIndex));
  let currentEntries = configIndex.entries();
  const claimedVisible = (vscode.window.visibleTextEditors || [])
    .filter((editor) => editor && editor.document && editor.document.languageId === 'yaml-dsl').length;
  log.info(`activated: ${currentEntries.length} DSL configs, ${claimedVisible} visible files claimed`);
  let theme = activeThemeOf(vscode);
  const canDecorate = Boolean(vscode.window.createTextEditorDecorationType);
  const referenceMarks = canDecorate
    ? {
      local: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' }),
      external: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline wavy' }),
      unclassified: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' }),
      ...themedProblemMarkTypes(vscode, context, theme),
    }
    : null;
  const paintable = await log.step(
    'underlining visible files from their text',
    () => (referenceMarks ? paintTextPass(vscode, referenceMarks, currentEntries) : []),
    [],
  );
  const suggestionGutterMarks = canDecorate ? themedSuggestionGutterMarkTypes(vscode, context, theme) : null;
  const scopeBorders = canDecorate ? themedScopeBorderTypes(vscode, theme) : null;
  subscriptions.push({
    dispose: () => {
      for (const types of [referenceMarks, suggestionGutterMarks, scopeBorders]) {
        if (types) disposeDecorationTypes(types);
      }
    },
  });
  const workspaceStorageName = workspaceStorageNameOf(vscode.workspace);
  const buildHash = await log.step('reading the extension build', readBuildHash, null);
  log.info(`extension build ${buildHash ? buildHash.slice(0, BUILD_HASH_SHOWN_LENGTH) : 'unknown'}`);
  const marksStore = createSuggestionMarksStore({
    storageFolder: context.globalStorageUri && workspaceStorageName
      ? vscode.Uri.joinPath(context.globalStorageUri, workspaceStorageName)
      : null,
    fileSystem: vscode.workspace.fs,
    joinPath: (folder, name) => vscode.Uri.joinPath(folder, name),
    parseUri: (uri) => vscode.Uri.parse(uri),
    timerFunctions: { setTimeout, clearTimeout },
    buildHash,
  });
  subscriptions.push({ dispose: () => { marksStore.flush(); } });
  const undoSaves = createSuggestionUndoSaves();
  let markViews = null;
  const marksKeptBy = (kindSettings, keptBy) => {
    const kept = new Map();
    for (const [uri, marks] of marksStore.marksByUri) {
      const keptMarks = marks.filter((mark) => keptBy(kindSettings[suggestionKindOf(mark.suggestion)]));
      if (keptMarks.length > 0) kept.set(uri, keptMarks);
    }
    return kept;
  };
  const markViewsNow = () => {
    if (markViews) return markViews;
    const { suggestion: kindSettings, warning, validator } = featureSettingsOf(vscode);
    const decoratingMarksByUri = marksKeptBy(kindSettings, (kindSetting) => kindSetting.fileDecoration);
    markViews = {
      shownMarksByUri: marksKeptBy(kindSettings, (kindSetting) => kindSetting.enabled),
      suggestionUriSets: explorerUriSets(suggestionFileUrisOf(decoratingMarksByUri)),
      warningUriSets: explorerUriSets(warning.deprecation.fileDecoration ? marksStore.warningUris() : []),
      validatorUriSets: explorerUriSets(validator.fileDecoration ? marksStore.validationErrorUris() : []),
    };
    return markViews;
  };
  const shownMarksByUri = () => markViewsNow().shownMarksByUri;
  const hasShownMarks = (uri) => (shownMarksByUri().get(uri) || []).length > 0;
  let overlayDiffViews = null;
  const suggestionHints = vscode.languages.registerInlayHintsProvider
    ? createInlayHintRegistration(
      vscode,
      { language: 'yaml-dsl' },
      (document) => suggestionInlayHints(vscode, theme, shownMarksByUri(), document),
    )
    : null;
  if (suggestionHints) subscriptions.push(suggestionHints);
  const fileDecorationsChanged = new vscode.EventEmitter();
  subscriptions.push(fileDecorationsChanged);
  const repaintScopeBorders = () => {
    if (scopeBorders) paintScopeBorders(vscode, scopeBorders, shownMarksByUri());
  };
  const repaintSuggestionMarks = () => {
    if (suggestionGutterMarks) paintSuggestionMarks(vscode, suggestionGutterMarks, shownMarksByUri());
    repaintScopeBorders();
  };
  if (vscode.window.onDidChangeTextEditorSelection) {
    subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
      repaintScopeBorders();
      if (referenceMarks && event) repaintProblemsOnCursorMove(vscode, referenceMarks, event.textEditor);
      if (overlayDiffViews && event) overlayDiffViews.followSelection(event.textEditor);
    }));
  }
  const redrawSuggestions = (changedUris) => {
    markViews = null;
    repaintSuggestionMarks();
    if (suggestionHints) suggestionHints.refreshHints(hasShownMarks);
    const changedExplorerUris = changedUris
      ? withAncestorFolders(changedUris).map((uri) => vscode.Uri.parse(uri))
      : undefined;
    fileDecorationsChanged.fire(changedExplorerUris);
  };
  if (vscode.window.registerFileDecorationProvider) {
    subscriptions.push(vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: fileDecorationsChanged.event,
      provideFileDecoration: (uri) => {
        const { validatorUriSets, warningUriSets, suggestionUriSets } = markViewsNow();
        const { errorSeverity } = featureSettingsOf(vscode).validator;
        return validatorFileDecoration(vscode, theme, errorSeverity, validatorUriSets, uri)
          || warningFileDecoration(vscode, theme, warningUriSets, uri)
          || suggestionFileDecoration(vscode, theme, suggestionUriSets, uri);
      },
    }));
  }
  await log.step('painting saved suggestions', async () => {
    if (!(await marksStore.load()).loaded) return;
    redrawSuggestions();
    log.info(`saved suggestions painted: ${marksStore.marksByUri.size} files`);
  });
  const declarationsPopup = createDeclarationsPopup(vscode);
  const client = startClient(context, () => currentEntries, outputChannel, declarationsPopup);
  log.info('language server starting');
  subscriptions.push({ dispose: () => client.stop() });
  const applyTheme = () => {
    const chosenTheme = activeThemeOf(vscode);
    if (chosenTheme === theme) return;
    theme = chosenTheme;
    log.info(`theme switched to ${theme}`);
    if (canDecorate) {
      swapDecorationTypes(referenceMarks, themedProblemMarkTypes(vscode, context, theme));
      swapDecorationTypes(suggestionGutterMarks, themedSuggestionGutterMarkTypes(vscode, context, theme));
      swapDecorationTypes(scopeBorders, themedScopeBorderTypes(vscode, theme));
      paintUnderlines(vscode, client, referenceMarks, currentEntries);
      repaintSuggestionMarks();
    }
    if (overlayDiffViews) overlayDiffViews.applyTheme(theme);
    if (suggestionHints) suggestionHints.refreshHints(hasShownMarks);
    fileDecorationsChanged.fire(undefined);
    sendTheme(client, theme);
  };
  if (vscode.workspace.onDidChangeConfiguration) {
    subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (featureSettingsAffected(event)) {
        forgetFeatureSettings(vscode);
        redrawSuggestions();
        if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
      }
      if (event.affectsConfiguration(CACHE_SETTINGS)) sendCacheCapacities(vscode, client);
      if (event.affectsConfiguration(THEME_SETTING)) applyTheme();
    }));
  }
  if (vscode.window.onDidChangeActiveColorTheme) {
    subscriptions.push(vscode.window.onDidChangeActiveColorTheme(applyTheme));
  }
  const releasedUris = new Set();
  if (vscode.workspace.onDidCloseTextDocument) {
    subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
      if (!doc || !doc.uri) return;
      releasedUris.delete(doc.uri.toString());
      paintGenerations.delete(doc.uri.toString());
      deprecatedFieldsByUri.delete(doc.uri.toString());
      analysisLoggedUris.delete(doc.uri.toString());
      if (suggestionHints) suggestionHints.forgetUri(doc.uri.toString());
    }));
  }
  if (vscode.window.tabGroups && vscode.window.tabGroups.onDidChangeTabs) {
    subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const uri of lastTabClosedUris(vscode, event.closed)) {
        releasedUris.add(uri);
        client.sendNotification('yaml-dsl/editorClosed', { uri }).catch(() => {});
      }
      for (const uri of reopenedUris([...(event.opened || []), ...(event.changed || [])], releasedUris)) {
        releasedUris.delete(uri);
        client.sendNotification('yaml-dsl/editorReopened', { uri }).catch(() => {});
      }
    }));
  }
  client.onNotification('yaml-dsl/suggestions', (params) => {
    const files = (params.files || []).map((file) => ({
      uri: editorUriKey(vscode, file.uri),
      textHash: file.textHash,
      schemaHash: file.schemaHash || null,
      warning: file.warning === true,
      validationError: file.validationError === true,
      marks: file.marks || [],
    }));
    redrawSuggestions(marksStore.replaceStack(params.stackId, files));
  });
  const refreshSuggestionsOf = (uris) => {
    if (uris.length === 0) return;
    const paths = uris.map((uri) => vscode.Uri.parse(uri).fsPath);
    client.sendNotification('yaml-dsl/refreshSuggestions', { paths }).catch(() => {});
  };
  let ownedFileWatchers = [];
  const ownedFileChanged = async (uri) => {
    const key = uri.toString();
    if (!(await marksStore.checkUri(key))) return;
    redrawSuggestions([key]);
    refreshSuggestionsOf([key]);
  };
  const dropStaleKeptSuggestions = (uris) => {
    const keys = (uris || []).map((uri) => editorUriKey(vscode, uri));
    const droppedKeys = keys.filter((key) => marksStore.dropUri(key));
    if (droppedKeys.length > 0) redrawSuggestions(droppedKeys);
    refreshSuggestionsOf(keys);
  };
  client.onNotification('yaml-dsl/keptSchemasChanged', (params) => dropStaleKeptSuggestions(params.uris));
  const ownedFileDeleted = (uri) => {
    const key = uri.toString();
    if (marksStore.dropUri(key)) redrawSuggestions([key]);
    const openDocument = (vscode.workspace.textDocuments || []).find((doc) => doc.uri.toString() === key);
    if (openDocument && !openDocument.isDirty) {
      client.sendNotification('yaml-dsl/fileDeleted', { uri: key }).catch(() => {});
    }
  };
  const watchOwnedFiles = () => {
    for (const watcher of ownedFileWatchers) watcher.dispose();
    ownedFileWatchers = vscode.workspace.createFileSystemWatcher
      ? ownedFilePatterns(vscode, currentEntries).map((pattern) => {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(ownedFileChanged);
        watcher.onDidCreate(ownedFileChanged);
        watcher.onDidDelete(ownedFileDeleted);
        return watcher;
      })
      : [];
  };
  subscriptions.push({ dispose: () => { for (const watcher of ownedFileWatchers) watcher.dispose(); } });
  client.onNotification('yaml-dsl/reanalyzed', (params) => {
    const uris = params.uris || [];
    for (const uri of uris) if (uri.startsWith('yaml-dsl-fold:')) emitter.fire(vscode.Uri.parse(uri));
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries, uris);
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
  if (vscode.commands && vscode.commands.registerCommand && vscode.window.createTextEditorDecorationType) {
    overlayDiffViews = createOverlayDiffViews(vscode, client, theme);
    subscriptions.push(...overlayDiffViews.disposables);
  }

  async function reloadConfig(changedConfigPaths = []) {
    await configIndex.reread(changedConfigPaths);
    await applyConfigs();
  }

  async function applyConfigs() {
    currentEntries = configIndex.entries();
    await claimOpenDocuments(vscode, currentEntries);
    try {
      await client.sendNotification('yaml-dsl/config', { entries: currentEntries });
    } catch {
      // The client may already be stopping.
    }
    watchOwnedFiles();
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
    await associateDslFiles(currentEntries, allConfigsListed);
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
      SHOW_DECLARATIONS_COMMAND,
      (location) => declarationsPopup.show(location),
    ));
    subscriptions.push(vscode.commands.registerCommand(
      APPLY_COMMAND,
      (argument) => applySuggestion(vscode, client, argument, undoSaves),
    ));
    subscriptions.push(vscode.commands.registerCommand(
      ACCEPT_LONE_SUGGESTION_COMMAND,
      () => vscode.commands.executeCommand(ACCEPT_SELECTED_SUGGESTION_COMMAND),
    ));
    subscriptions.push(vscode.commands.registerCommand(TOGGLE_THEME_COMMAND, () => toggleTheme(vscode)));
  }

  async function analyzeInBackground() {
    await sendCacheCapacities(vscode, client);
    await sendTheme(client, theme);
    await client.sendNotification('yaml-dsl/config', { entries: currentEntries }).catch(() => {});
    const state = publishEditorState(vscode, client);
    const painted = paintAnalyses(vscode, client, referenceMarks, paintable);
    const verified = marksStore.verifySavedTexts().then(({ changedUris, staleUris }) => {
      if (changedUris.length > 0) redrawSuggestions(changedUris);
      refreshSuggestionsOf(staleUris);
      client.sendRequest('yaml-dsl/staleKeptSchemas', { files: marksStore.keptSchemaHashes() })
        .then((answer) => dropStaleKeptSuggestions(answer ? answer.uris : []))
        .catch((error) => log.failure('checking kept suggestions against their schemas', error));
    });
    await Promise.all([state, painted, associated, verified]);
  }
  const listedConfigsApplied = listed.then((learned) => {
    allConfigsListed = true;
    return learned ? applyConfigs() : associateDslFiles(currentEntries, allConfigsListed);
  });
  const startup = Promise.all([analyzeInBackground(), listedConfigsApplied])
    .catch((error) => log.failure('background startup', error));
  watchOwnedFiles();

  const watcher = vscode.workspace.createFileSystemWatcher('**/yaml-dsl.yml');
  const reload = (configUri) => { reloadConfig(configUri && configUri.fsPath ? [configUri.fsPath] : []); };
  subscriptions.push(watcher.onDidChange(reload));
  subscriptions.push(watcher.onDidCreate(reload));
  subscriptions.push(watcher.onDidDelete(reload));
  subscriptions.push(watcher);
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => reloadConfig()));
  }
  subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc && doc.uri && doc.uri.scheme === 'yaml-dsl-fold' && doc.languageId !== 'yaml-dsl') {
      vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    }
    return claimWithConfigsAbove(vscode, configIndex, doc).then((learned) => (learned ? applyConfigs() : undefined)).then(() => {
      if (!referenceMarks || !doc || !doc.uri || doc.languageId !== 'yaml-dsl') return undefined;
      return paintUnderlines(vscode, client, referenceMarks, currentEntries, [doc.uri.toString()]);
    });
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    const editsText = event.contentChanges.length > 0;
    if (editsText && event.document.languageId === 'yaml-dsl' && event.document.uri.scheme === 'file') {
      const key = event.document.uri.toString();
      if (marksStore.clearUri(key)) redrawSuggestions([key]);
    }
    if (overlayDiffViews && event.document.uri.scheme === OVERLAY_DIFF_SCHEME) overlayDiffViews.paintVisible();
    undoSaves.documentChanged(event.document, changedByUndoOrRedo(vscode, event));
    if (editsText && event.document.uri.scheme === 'file') {
      fillRequiredFieldsAfterEnter(vscode, client, event)
        .catch((error) => log.failure('filling required fields', error));
    }
  }));
  subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    const published = publishEditorState(vscode, client);
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
    return published;
  }));
  subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    const published = publishEditorState(vscode, client);
    if (referenceMarks) paintUnderlines(vscode, client, referenceMarks, currentEntries);
    repaintSuggestionMarks();
    if (overlayDiffViews) overlayDiffViews.paintVisible();
    return published;
  }));
  claimOpenDocuments(vscode, currentEntries);
  return { client, reloadConfig, startup };
}

function makeRange(vscode, startLine, startCharacter, endLine, endCharacter) {
  if (vscode.Range) return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function namesBuiltins(rule, dsl) {
  const scope = dsl.scopes ? dsl.scopes[rule.scopeName] : null;
  return Boolean(scope && scope.builtinNames.length > 0);
}

function valueEnd(line, valueStart) {
  const quote = openingQuoteBefore(line, valueStart);
  if (quote) {
    const closingQuote = line.indexOf(quote, valueStart);
    return closingQuote < 0 ? line.length : closingQuote;
  }
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
const paintedProblems = new WeakMap();
const analysisLoggedUris = new Set();
const deprecatedFieldsByUri = new Map();
let activityLog = null;

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

function htmlMarkdown(vscode, text) {
  if (!vscode.MarkdownString) return text;
  const markdown = new vscode.MarkdownString(text);
  markdown.supportHtml = true;
  return markdown;
}

function validationErrorsText(problems, theme) {
  const items = problems.map((problem) => `- ${markdownWithoutHtml(problem.message)}`);
  const headingColor = themeColorVariable(theme, THEME_ROLES.validationErrorsHeading);
  return `${hoverHeading(VALIDATION_ERRORS_TITLE, headingColor)}\n\n${items.join('\n')}`;
}

function problemDecorations(vscode, doc, problems) {
  const decorations = [];
  const validationErrorsByRange = new Map();
  for (const problem of problems) {
    const decoration = problemDecoration(vscode, doc, problem);
    if (problem.kind !== PROBLEM_KINDS.validationError) {
      decorations.push(decoration);
      continue;
    }
    const rangeKey = JSON.stringify(problem.range);
    if (!validationErrorsByRange.has(rangeKey)) {
      validationErrorsByRange.set(rangeKey, { range: decoration.range, problems: [] });
      decorations.push(validationErrorsByRange.get(rangeKey));
    }
    validationErrorsByRange.get(rangeKey).problems.push(problem);
  }
  return decorations.map((decoration) => (decoration.problems
    ? {
      range: decoration.range,
      hoverMessage: htmlMarkdown(vscode, validationErrorsText(decoration.problems, activeThemeOf(vscode))),
    }
    : decoration));
}

function withHtmlSupported(hover) {
  if (!hover || !hover.contents) return hover;
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  for (const content of contents) {
    if (content && typeof content === 'object' && typeof content.value === 'string') content.supportHtml = true;
  }
  return hover;
}

function paintTextPass(vscode, referenceMarks, entries, onlyUris) {
  const editors = (vscode.window && vscode.window.visibleTextEditors) || [];
  const requestedUris = onlyUris ? new Set(onlyUris) : null;
  const paintable = [];
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
    paintable.push(editor);
  }
  return paintable;
}

async function paintUnderlines(vscode, client, referenceMarks, entries, onlyUris) {
  const paintable = paintTextPass(vscode, referenceMarks, entries, onlyUris);
  await paintAnalyses(vscode, client, referenceMarks, paintable);
}

function paintAnalyses(vscode, client, referenceMarks, editors) {
  return Promise.all(editors.map((editor) => paintAnalysis(vscode, client, referenceMarks, editor)));
}

function cursorLineOf(editor) {
  return editor.selection ? editor.selection.active.line : null;
}

function isUnfinishedKeyOnLine(problem, line) {
  return problem.kind === PROBLEM_KINDS.unfinishedKey && problem.range.start.line === line;
}

function paintProblemMarks(vscode, referenceMarks, editor) {
  const painted = paintedProblems.get(editor);
  if (!painted) return;
  const doc = editor.document;
  painted.cursorLine = cursorLineOf(editor);
  const problems = painted.problems.filter((problem) => !isUnfinishedKeyOnLine(problem, painted.cursorLine));
  const errorMarks = problemDecorations(vscode, doc, problems
    .filter((problem) => problem.severity !== INFO_SEVERITY && problem.severity !== WARNING_SEVERITY));
  errorMarks.push(...painted.referenceErrorRanges.map((range) => ({ range })));
  const warningMarks = problemDecorations(vscode, doc, problems
    .filter((problem) => problem.severity === WARNING_SEVERITY && problem.kind !== PROBLEM_KINDS.deprecation));
  warningMarks.push(...problems
    .filter((problem) => problem.severity === WARNING_SEVERITY && problem.kind === PROBLEM_KINDS.deprecation)
    .map((problem) => ({ range: problemDecoration(vscode, doc, problem).range })));
  const infoMarks = problemDecorations(vscode, doc, problems
    .filter((problem) => problem.severity === INFO_SEVERITY));
  editor.setDecorations(referenceMarks.error, errorMarks);
  editor.setDecorations(referenceMarks.warning, warningMarks);
  editor.setDecorations(referenceMarks.info, infoMarks);
  const warningUnderlines = problems
    .filter((problem) => problem.severity === WARNING_SEVERITY && problem.kind !== PROBLEM_KINDS.deprecation)
    .map((problem) => problemDecoration(vscode, doc, problem).range);
  editor.setDecorations(referenceMarks.warningUnderline, warningUnderlines);
}

function repaintProblemsOnCursorMove(vscode, referenceMarks, editor) {
  const painted = paintedProblems.get(editor);
  if (!painted) return;
  const previousLine = painted.cursorLine;
  const cursorLine = cursorLineOf(editor);
  if (cursorLine === previousLine) return;
  painted.cursorLine = cursorLine;
  const shownChanges = painted.problems.some((problem) => isUnfinishedKeyOnLine(problem, previousLine)
    || isUnfinishedKeyOnLine(problem, cursorLine));
  if (shownChanges) paintProblemMarks(vscode, referenceMarks, editor);
}

async function paintAnalysis(vscode, client, referenceMarks, editor) {
  const doc = editor.document;
  const documentKey = doc.uri.toString();
  const paintGeneration = (paintGenerations.get(documentKey) || 0) + 1;
  paintGenerations.set(documentKey, paintGeneration);
  const requestedAt = Date.now();
  let answer = null;
  try {
    answer = await client.sendRequest('yaml-dsl/decorations', { uri: documentKey });
  } catch {
    answer = null;
  }
  if (paintGenerations.get(documentKey) !== paintGeneration) return;
  if (!answer || typeof answer !== 'object') return;
  if (activityLog && !analysisLoggedUris.has(documentKey)) {
    analysisLoggedUris.add(documentKey);
    const shownPath = vscode.workspace && vscode.workspace.asRelativePath
      ? vscode.workspace.asRelativePath(doc.uri)
      : documentKey;
    activityLog.info(`${shownPath} analyzed in ${Date.now() - requestedAt} ms`);
  }
  const { warning, validator } = featureSettingsOf(vscode);
  const deprecationWarningsShown = warning.deprecation.enabled;
  const problems = (answer.problems || [])
    .filter((problem) => deprecationWarningsShown || problem.kind !== PROBLEM_KINDS.deprecation)
    .filter((problem) => validator.enabled || problem.kind !== PROBLEM_KINDS.validationError)
    .map((problem) => (problem.kind === PROBLEM_KINDS.validationError
      ? { ...problem, severity: validator.errorSeverity }
      : problem));
  const referenceErrorRanges = [];
  if (Array.isArray(answer.references)) {
    const rangesByClass = { local: [], external: [], unclassified: [] };
    for (const reference of answer.references) {
      const range = editorRange(vscode, reference.range);
      if (reference.kind === 'error') {
        referenceErrorRanges.push(range);
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
  paintedProblems.set(editor, { problems, referenceErrorRanges, cursorLine: null });
  paintProblemMarks(vscode, referenceMarks, editor);
  if (Array.isArray(answer.deprecatedFields)) {
    const deprecatedFields = deprecationWarningsShown ? answer.deprecatedFields : [];
    deprecatedFieldsByUri.set(documentKey, deprecatedFields);
    const deprecatedKeys = deprecatedFields.map((field) => editorRange(vscode, field.keyRange));
    editor.setDecorations(referenceMarks.deprecated, deprecatedKeys);
  }
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

function coloredSpans(line, dsl, theme) {
  const spans = new Map();
  if (!dsl) return spans;
  const rules = dsl.references || [];
  const placeholderColor = themeColorVariable(theme, THEME_ROLES.declarationPlaceholder);
  const referenceColor = themeColorVariable(theme, THEME_ROLES.declarationReference);
  for (const placeholder of scanPlaceholders(line, dsl.placeholder, rules)) {
    spans.set(placeholder.start, { end: placeholder.end, color: placeholderColor });
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
      spans.set(start, { end: start + literalText.length, color: referenceColor });
    }
  }
  return spans;
}

function colorYamlLine(line, dsl, theme) {
  const spans = coloredSpans(line, dsl, theme);
  const commentColor = themeColorVariable(theme, THEME_ROLES.declarationComment);
  const stringColor = themeColorVariable(theme, THEME_ROLES.declarationString);
  const keyColor = themeColorVariable(theme, THEME_ROLES.declarationKey);
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
      out += `<span style="color:${commentColor};">${escapeHtml(line.slice(i))}</span>`;
      break;
    }
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        j += line[j] === '\\' ? 2 : 1;
      }
      if (j < line.length) j += 1;
      out += `<span style="color:${stringColor};">${escapeHtml(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    const key = line.slice(i).match(/^([A-Za-z_][\w.-]*)(\s*:)/);
    if (key && (i === 0 || /\s/.test(line[i - 1]))) {
      out += `<span style="color:${keyColor};">${escapeHtml(key[1])}</span>${escapeHtml(key[2])}`;
      i += key[0].length;
      continue;
    }
    out += escapeHtml(line[i]);
    i += 1;
  }
  return out;
}

function hoverBody(code, dsl, theme) {
  // One line. A blank line ends an HTML block, and a code fence is a separate clipped box.
  const lines = code.split('\n').map((line) => {
    if (line === '') return '&nbsp;';
    return colorYamlLine(line.replace(/ /g, '\u00a0'), dsl, theme);
  });
  return `<div>${lines.join('<br>')}</div>`;
}

function declarationLinksIn(text) {
  return [...text.matchAll(/\[([^\]]+)\]\((file:\/\/[^)\s]+)#L(\d+)\)/g)];
}

function openableLocation(vscode, hover, entries) {
  if (!vscode.MarkdownString || !vscode.Hover) return hover;
  const text = hoverText(hover);
  const matches = declarationLinksIn(text);
  if (matches.length === 0) return hover;
  const sections = matches.map((match, index) => {
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
    const sectionEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const fenced = text.slice(match.index + match[0].length, sectionEnd).match(/```yaml-dsl\n([\s\S]*?)\n```/);
    const declaringPath = decodeURIComponent(match[2].replace(/^file:\/\//, ''));
    const body = fenced ? hoverBody(fenced[1], owningDsl(entries, declaringPath), activeThemeOf(vscode)) : '';
    return `<div><a href="${href}"><code><u>${label}</u></code></a>${body}</div>`;
  });
  const md = new vscode.MarkdownString();
  md.supportHtml = true;
  md.isTrusted = { enabledCommands: [PEEK_COMMAND] };
  md.appendMarkdown(sections.join(''));
  return new vscode.Hover(md, hover.range);
}

function rangeHolds(range, position) {
  const startsBefore = range.start.line < position.line
    || (range.start.line === position.line && range.start.character <= position.character);
  const endsAfter = range.end.line > position.line
    || (range.end.line === position.line && range.end.character >= position.character);
  return startsBefore && endsAfter;
}

function editorMiddleware(vscode, configEntries = () => [], declarationsPopup = createDeclarationsPopup(vscode)) {
  let hintedLine = null;
  return {
    async provideSignatureHelp(document, position, context, token, next) {
      const lineKey = `${document.uri.toString()}#${position.line}`;
      if (context.triggerKind === vscode.SignatureHelpTriggerKind.Invoke) hintedLine = lineKey;
      if (hintedLine !== lineKey) {
        hintedLine = null;
        return null;
      }
      return next(document, position, context, token);
    },
    async provideHover(document, position, token, next) {
      const deprecatedFields = (deprecatedFieldsByUri.get(document.uri.toString()) || [])
        .filter((field) => rangeHolds(field.fieldRange, position));
      if (deprecatedFields.length > 0) {
        const innermostField = deprecatedFields[deprecatedFields.length - 1];
        return new vscode.Hover(
          new vscode.MarkdownString(innermostField.message),
          editorRange(vscode, innermostField.fieldRange),
        );
      }
      const opened = declarationsPopup.opensHoverAt(document, position);
      const hover = await next(document, position, token);
      if (!opened && declarationLinksIn(hoverText(hover)).length > 0) return null;
      return withHtmlSupported(openableLocation(vscode, hover, configEntries()));
    },
    async provideDocumentLinks(document, token, next) {
      const links = await next(document, token);
      return links ? links.map((link) => declarationsPopup.declarationsLink(document, link)) : links;
    },
  };
}

module.exports = {
  activateWith,
  foldUri,
  parseFoldPath,
  visibleFoldStacks,
  applyAssociations,
  claimOpenDocuments,
  ownedFile,
  closeEvicted,
  revealFolds,
  publishEditorState,
  editorMiddleware,
  paintUnderlines,
  repaintProblemsOnCursorMove,
};

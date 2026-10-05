const { parseConfig } = require('./config');
const { matchAny } = require('./glob');

function foldUri(vscode, stackId, env) {
  return vscode.Uri.from({
    scheme: 'yaml-dsl-fold',
    path: `/${encodeURIComponent(stackId)}/${encodeURIComponent(env)}`,
  });
}

function parseFoldPath(uriPath) {
  if (!uriPath || !uriPath.startsWith('/')) return null;
  const trimmed = uriPath.slice(1);
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return null;
  return {
    stackId: decodeURIComponent(trimmed.slice(0, slash)),
    env: decodeURIComponent(trimmed.slice(slash + 1)),
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
  const entries = [];
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, 'yaml-dsl.yml');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      entries.push({ text: Buffer.from(bytes).toString('utf8'), dir: folder.uri.fsPath });
    } catch {
      // This folder has no yaml-dsl.yml.
    }
  }
  return entries;
}

function associationPatterns(match) {
  const patterns = [];
  const seen = new Set();
  function add(pattern) {
    if (!pattern || seen.has(pattern)) return;
    seen.add(pattern);
    patterns.push(pattern);
  }
  for (const pattern of match) {
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
    if (parsed.dsls.some((dsl) => matchAny(dsl.match, filePath))) return true;
  }
  return false;
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
  for (const doc of vscode.workspace.textDocuments || []) {
    if (!doc.uri || doc.uri.scheme !== 'file') continue;
    const owned = ownedFile(doc.uri.fsPath, entries);
    if (owned && doc.languageId !== 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    if (!owned && doc.languageId === 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml');
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
  if (!info || !info.stackId || !info.environments || info.environments.length !== 1) return;
  try {
    await peekFold(vscode, editor, foldUri(vscode, info.stackId, info.environments[0]));
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
  const client = startClient(context);
  const subscriptions = context.subscriptions;
  subscriptions.push({ dispose: () => client.stop() });
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

  let currentEntries = [];
  async function reloadConfig() {
    currentEntries = await readConfigs(vscode);
    await applyAssociations(vscode);
    await claimOpenDocuments(vscode, currentEntries);
    try {
      await client.sendNotification('yaml-dsl/config', { entries: currentEntries });
    } catch {
      // The client may already be stopping.
    }
  }

  const inFile = vscode.window.createTextEditorDecorationType
    ? vscode.window.createTextEditorDecorationType({ textDecoration: 'underline', color: '#87C3FF' })
    : null;
  const outFile = vscode.window.createTextEditorDecorationType
    ? vscode.window.createTextEditorDecorationType({ textDecoration: 'underline', color: '#efb080' })
    : null;
  if (inFile && outFile) {
    subscriptions.push(inFile, outFile);
    paintUnderlines(vscode, inFile, outFile);
  }

  if (vscode.commands && vscode.commands.registerCommand) {
    subscriptions.push(vscode.commands.registerCommand('yaml-dsl.peek', async (arg) => {
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
      return vscode.window.showTextDocument(doc, { selection: range, preview: true });
    }));
  }

  await reloadConfig();
  await publishEditorState(vscode, client, true);

  const watcher = vscode.workspace.createFileSystemWatcher('**/yaml-dsl.yml');
  const reload = () => { reloadConfig(); };
  subscriptions.push(watcher.onDidChange(reload));
  subscriptions.push(watcher.onDidCreate(reload));
  subscriptions.push(watcher.onDidDelete(reload));
  subscriptions.push(watcher);
  subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc && doc.uri && doc.uri.scheme === 'yaml-dsl-fold' && doc.languageId !== 'yaml-dsl') {
      vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    }
    claimOpenDocuments(vscode, currentEntries);
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === 'yaml-dsl' && event.document.uri.scheme === 'file') {
      emitter.fire(event.document.uri);
      if (inFile && outFile) paintUnderlines(vscode, inFile, outFile);
    }
  }));
  subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    publishEditorState(vscode, client, true);
    if (inFile && outFile) paintUnderlines(vscode, inFile, outFile);
  }));
  subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    publishEditorState(vscode, client, false);
    if (inFile && outFile) paintUnderlines(vscode, inFile, outFile);
  }));
  client.onNotification('yaml-dsl/evicted', (params) => {
    closeEvicted(vscode, params.stackIds || []);
  });
  return { client, reloadConfig };
}

function leavesFile(document, link) {
  const target = link && link.target;
  if (!target || !link.range) return null;
  if (target.scheme === 'command') return true;
  if (target.scheme !== 'file' || !document.uri) return false;
  const bare = target.fragment && target.with ? target.with({ fragment: '' }) : target;
  return bare.toString() !== document.uri.toString();
}

async function paintUnderlines(vscode, inFile, outFile) {
  const editors = (vscode.window && vscode.window.visibleTextEditors) || [];
  for (const editor of editors) {
    const doc = editor && editor.document;
    if (!doc || doc.languageId !== 'yaml-dsl' || !editor.setDecorations) {
      if (editor && editor.setDecorations) {
        editor.setDecorations(inFile, []);
        editor.setDecorations(outFile, []);
      }
      continue;
    }
    let links = [];
    try {
      links = await vscode.commands.executeCommand('vscode.executeLinkProvider', doc.uri) || [];
    } catch {
      links = [];
    }
    const here = [];
    const away = [];
    for (const link of links) {
      const outside = leavesFile(doc, link);
      if (outside === null) continue;
      (outside ? away : here).push(link.range);
    }
    editor.setDecorations(inFile, here);
    editor.setDecorations(outFile, away);
  }
}

function sectionOf(vscode, target) {
  const uri = typeof target === 'string' ? vscode.Uri.parse(target) : target;
  if (!uri || uri.scheme !== 'file' || !uri.fragment) return null;
  const parts = uri.fragment.split(',').map((item) => Number(item));
  if (parts.length < 2 || parts.some((item) => Number.isNaN(item))) return null;
  const startLine = parts[0] - 1;
  const startCharacter = parts[1] - 1;
  const endLine = (parts.length >= 4 ? parts[2] : parts[0]) - 1;
  const endCharacter = (parts.length >= 4 ? parts[3] : parts[1]) - 1;
  return {
    uri: uri.with({ fragment: '' }),
    range: new vscode.Range(startLine, startCharacter, endLine, endCharacter),
  };
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

function editorMiddleware(vscode) {
  return {
    async provideHover(document, position, token, next) {
      if (token && !token.isCancellationRequested) {
        const cancelled = await waitForHover(HOVER_PEEK_DELAY, token);
        if (cancelled || token.isCancellationRequested) return null;
      }
      return next(document, position, token);
    },
    async provideDocumentLinks(document, token, next) {
      const links = await next(document, token);
      if (!links) return links;
      for (const link of links) {
        if (!link.target) continue;
        const section = sectionOf(vscode, link.target);
        if (!section || section.uri.toString() === document.uri.toString()) continue;
        const arg = {
          uri: section.uri.toString(),
          startLine: section.range.start.line,
          startCharacter: section.range.start.character,
          endLine: section.range.end.line,
          endCharacter: section.range.end.character,
        };
        link.target = vscode.Uri.parse(`command:yaml-dsl.peek?${encodeURIComponent(JSON.stringify(arg))}`);
      }
      return links;
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
  sectionOf,
  paintUnderlines,
};

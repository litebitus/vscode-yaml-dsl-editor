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

function dslsFrom(entries) {
  const dsls = [];
  for (const entry of entries) {
    const parsed = parseConfig(entry.text);
    for (const dsl of parsed.dsls) dsls.push(dsl);
  }
  return dsls;
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

async function applyAssociations(vscode, dsls) {
  const desired = {};
  for (const dsl of dsls) {
    for (const pattern of associationPatterns(dsl.match)) desired[pattern] = 'yaml-dsl';
  }
  const cfg = vscode.workspace.getConfiguration('files');
  const current = { ...(cfg.get('associations') || {}) };
  let changed = false;
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] !== value) {
      current[key] = value;
      changed = true;
    }
  }
  if (changed) await cfg.update('associations', current, vscode.ConfigurationTarget.Workspace);
}

async function claimOpenDocuments(vscode, dsls) {
  for (const doc of vscode.workspace.textDocuments || []) {
    if (!doc.uri || doc.uri.scheme !== 'file') continue;
    const hit = dsls.some((dsl) => matchAny(dsl.match, doc.uri.fsPath));
    if (hit && doc.languageId !== 'yaml-dsl') await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
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

function foldIsVisible(vscode, uri) {
  for (const editor of vscode.window.visibleTextEditors || []) {
    const open = editor.document && editor.document.uri;
    if (open && open.scheme === uri.scheme && open.path === uri.path) return true;
  }
  return false;
}

async function revealFolds(vscode, client, editor) {
  if (!editor || !editor.document) return;
  if (editor.document.languageId !== 'yaml-dsl') return;
  if (editor.document.uri.scheme !== 'file') return;
  let info;
  try {
    info = await client.sendRequest('yaml-dsl/foldsFor', { path: editor.document.uri.fsPath });
  } catch {
    return;
  }
  if (!info || !info.stackId || !info.environments || info.environments.length === 0) return;
  for (const env of info.environments) {
    const uri = foldUri(vscode, info.stackId, env);
    if (foldIsVisible(vscode, uri)) continue;
    try {
      await vscode.window.showTextDocument(uri, {
        preserveFocus: true,
        preview: true,
      });
    } catch {
      return;
    }
  }
}

let publishing = false;

async function publishEditorState(vscode, client, reveal) {
  if (publishing) return;
  publishing = true;
  try {
    const editor = vscode.window.activeTextEditor;
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
    if (reveal) await revealFolds(vscode, client, editor);
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

  let currentDsls = [];
  async function reloadConfig() {
    const entries = await readConfigs(vscode);
    currentDsls = dslsFrom(entries);
    await applyAssociations(vscode, currentDsls);
    await claimOpenDocuments(vscode, currentDsls);
    try {
      await client.sendNotification('yaml-dsl/config', { entries });
    } catch {
      // The client may already be stopping.
    }
  }

  await reloadConfig();
  await publishEditorState(vscode, client, true);

  const watcher = vscode.workspace.createFileSystemWatcher('**/yaml-dsl.yml');
  const reload = () => { reloadConfig(); };
  subscriptions.push(watcher.onDidChange(reload));
  subscriptions.push(watcher.onDidCreate(reload));
  subscriptions.push(watcher.onDidDelete(reload));
  subscriptions.push(watcher);
  subscriptions.push(vscode.workspace.onDidOpenTextDocument(() => {
    claimOpenDocuments(vscode, currentDsls);
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === 'yaml-dsl' && event.document.uri.scheme === 'file') {
      emitter.fire(event.document.uri);
    }
  }));
  subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    publishEditorState(vscode, client, true);
  }));
  subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    publishEditorState(vscode, client, false);
  }));
  client.onNotification('yaml-dsl/evicted', (params) => {
    closeEvicted(vscode, params.stackIds || []);
  });
  return { client, reloadConfig };
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
  closeEvicted,
  revealFolds,
  publishEditorState,
};

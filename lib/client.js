const path = require('path');
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
  const listed = readConfigs(vscode);
  await claimVisible(vscode);
  let currentEntries = await listed;
  await claimOpenDocuments(vscode, currentEntries);
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

  async function reloadConfig() {
    currentEntries = await readConfigs(vscode);
    await claimOpenDocuments(vscode, currentEntries);
    try {
      await client.sendNotification('yaml-dsl/config', { entries: currentEntries });
    } catch {
      // The client may already be stopping.
    }
    if (inFile && outFile) paintUnderlines(vscode, inFile, outFile, plain, currentEntries);
    applyAssociations(vscode);
  }

  const inFile = vscode.window.createTextEditorDecorationType
    ? vscode.window.createTextEditorDecorationType({ textDecoration: 'underline', color: '#87C3FF' })
    : null;
  const outFile = vscode.window.createTextEditorDecorationType
    ? vscode.window.createTextEditorDecorationType({ textDecoration: 'underline', color: '#efb080' })
    : null;
  const plain = vscode.window.createTextEditorDecorationType
    ? vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' })
    : null;
  if (inFile && outFile) subscriptions.push(inFile, outFile, plain);

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
      if (doc && doc.languageId && doc.languageId !== 'yaml-dsl' && doc.uri && ownedFile(doc.uri.fsPath, currentEntries)) {
        await vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
      }
      return vscode.window.showTextDocument(doc, { selection: range, preview: true });
    }));
  }

  const state = publishEditorState(vscode, client, true);
  await client.sendNotification('yaml-dsl/config', { entries: currentEntries }).catch(() => {});
  const links = inFile && outFile ? paintUnderlines(vscode, inFile, outFile, plain, currentEntries) : null;
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
  subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc && doc.uri && doc.uri.scheme === 'yaml-dsl-fold' && doc.languageId !== 'yaml-dsl') {
      vscode.languages.setTextDocumentLanguage(doc, 'yaml-dsl');
    }
    claimOpenDocuments(vscode, currentEntries);
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === 'yaml-dsl' && event.document.uri.scheme === 'file') {
      emitter.fire(event.document.uri);
      if (inFile && outFile) paintUnderlines(vscode, inFile, outFile, plain, currentEntries);
    }
  }));
  subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    publishEditorState(vscode, client, true);
    if (inFile && outFile) paintUnderlines(vscode, inFile, outFile, plain, currentEntries);
  }));
  subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
    publishEditorState(vscode, client, false);
    if (inFile && outFile) paintUnderlines(vscode, inFile, outFile, plain, currentEntries);
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

function offsetAt(range, text, offset) {
  let line = range.start.line;
  let character = range.start.character;
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

function spanBetween(range, text, from, to) {
  return { start: offsetAt(range, text, from), end: offsetAt(range, text, to) };
}

function makeRange(vscode, startLine, startCharacter, endLine, endCharacter) {
  if (vscode.Range) return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function referenceRules(entries) {
  const rules = [];
  for (const entry of entries || []) {
    const parsed = parseConfig(entry.text);
    if (!parsed.ok) continue;
    for (const dsl of parsed.dsls) {
      for (const rule of dsl.references || []) rules.push(rule);
    }
  }
  return rules;
}

function rangesInText(vscode, text, rules) {
  const ranges = [];
  String(text || '').split('\n').forEach((line, lineNo) => {
    const indent = line.match(/^\s*(?:-\s+)?/)[0].length;
    const rest = line.slice(indent);
    for (const rule of rules) {
      if (rule.where === 'within') {
        const re = new RegExp(rule.pattern, 'g');
        let match = re.exec(line);
        while (match) {
          let from = match.index;
          let to = match.index + match[0].length;
          if (match[0].startsWith('${') && match[0].endsWith('}')) {
            from += 2;
            to -= 1;
          }
          ranges.push(makeRange(vscode, lineNo, from, lineNo, to));
          if (match[0].length === 0) break;
          match = re.exec(line);
        }
        continue;
      }
      const re = new RegExp(`^(?:${rule.pattern.replace(/^\^/, '')})`);
      const match = rest.match(re);
      if (match) ranges.push(makeRange(vscode, lineNo, indent, lineNo, indent + match[0].length));
    }
  });
  return ranges;
}

function withoutPlaceholders(doc, range) {
  if (!range || !range.start || !doc || typeof doc.getText !== 'function') {
    return { color: range ? [range] : [], plain: [] };
  }
  const text = doc.getText(range);
  const color = [];
  const plain = [];
  const re = /\$\{[^}\n]*\}/g;
  let cursor = 0;
  let match = re.exec(text);
  while (match) {
    if (match.index > cursor) color.push(spanBetween(range, text, cursor, match.index));
    plain.push(spanBetween(range, text, match.index, match.index + match[0].length));
    cursor = match.index + match[0].length;
    match = re.exec(text);
  }
  if (cursor < text.length) color.push(spanBetween(range, text, cursor, text.length));
  if (color.length === 0 && plain.length === 0) color.push(range);
  return { color, plain };
}

async function paintUnderlines(vscode, inFile, outFile, plainMark, entries) {
  const rules = referenceRules(entries);
  const editors = (vscode.window && vscode.window.visibleTextEditors) || [];
  for (const editor of editors) {
    const doc = editor && editor.document;
    if (!doc || doc.languageId !== 'yaml-dsl' || !editor.setDecorations) {
      if (editor && editor.setDecorations) {
        editor.setDecorations(inFile, []);
        editor.setDecorations(outFile, []);
        if (plainMark) editor.setDecorations(plainMark, []);
      }
      continue;
    }
    // The language server is not on this path. Underlines come from the text already in the editor.
    if (rules.length && typeof doc.getText === 'function') {
      const marked = [];
      const holders = [];
      for (const range of rangesInText(vscode, doc.getText(), rules)) {
        const parts = withoutPlaceholders(doc, range);
        marked.push(...parts.color);
        holders.push(...parts.plain);
      }
      editor.setDecorations(inFile, []);
      editor.setDecorations(outFile, marked);
      if (plainMark) editor.setDecorations(plainMark, holders);
    }
    let links = [];
    try {
      links = await vscode.commands.executeCommand('vscode.executeLinkProvider', doc.uri) || [];
    } catch {
      links = [];
    }
    if (!links.length) continue;
    const here = [];
    const away = [];
    const holders = [];
    for (const link of links) {
      const outside = leavesFile(doc, link);
      if (outside === null) continue;
      const parts = withoutPlaceholders(doc, link.range);
      (outside ? away : here).push(...parts.color);
      holders.push(...parts.plain);
    }
    editor.setDecorations(inFile, here);
    editor.setDecorations(outFile, away);
    if (plainMark) editor.setDecorations(plainMark, holders);
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

function colorYamlLine(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '#' && (i === 0 || (line[i - 1] !== '"' && line[i - 1] !== "'"))) {
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
    if (line.startsWith('${', i)) {
      const end = line.indexOf('}', i);
      const stop = end < 0 ? line.length : end + 1;
      out += `<span style="color:#82D2CE;">${escapeHtml(line.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    if (line.startsWith('ref', i) && (i === 0 || /\s/.test(line[i - 1]))) {
      out += '<span style="color:#efb080;">ref</span>';
      i += 3;
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

function hoverBody(code) {
  // One line. A blank line ends an HTML block, and a code fence is a separate clipped box.
  const lines = code.split('\n').map((line) => {
    if (line === '') return '&nbsp;';
    return colorYamlLine(line.replace(/ /g, '\u00a0'));
  });
  return `<div>${lines.join('<br>')}</div>`;
}

function openableLocation(vscode, hover) {
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
  const href = `command:yaml-dsl.peek?${encodeURIComponent(JSON.stringify(arg))}`;
  const label = escapeHtml(match[1]);
  const fenced = text.slice(match.index + match[0].length).match(/```yaml-dsl\n([\s\S]*?)\n```/);
  const body = fenced ? hoverBody(fenced[1]) : '';
  const md = new vscode.MarkdownString();
  md.supportHtml = true;
  md.isTrusted = { enabledCommands: ['yaml-dsl.peek'] };
  md.appendMarkdown(`<div><a href="${href}"><code><u>${label}</u></code></a>${body}</div>`);
  return new vscode.Hover(md, hover.range);
}

function editorMiddleware(vscode) {
  return {
    async provideHover(document, position, token, next) {
      if (token && !token.isCancellationRequested) {
        const cancelled = await waitForHover(HOVER_PEEK_DELAY, token);
        if (cancelled || token.isCancellationRequested) return null;
      }
      return openableLocation(vscode, await next(document, position, token));
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

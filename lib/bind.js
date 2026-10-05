const { DidChangeWatchedFilesNotification } = require('vscode-languageserver/node');
const { createWorkspace } = require('./workspace');
const { readFileOrNull, fetchTextOrNull } = require('./io');
const { pathToUri, uriToPath, linkTarget } = require('./analyze');

function bind(connection, documents, options = {}) {
  const workspace = options.workspace || createWorkspace({
    readFile: options.readFile || readFileOrNull,
    fetchText: options.fetchText || fetchTextOrNull,
  });

  let watchesFiles = false;
  let watchKey = '';
  let watchRegistration = null;

  connection.onInitialize((params) => {
    const workspaceCapabilities = (params && params.capabilities && params.capabilities.workspace) || {};
    const fileWatching = workspaceCapabilities.didChangeWatchedFiles || {};
    watchesFiles = Boolean(fileWatching.dynamicRegistration && fileWatching.relativePatternSupport);
    return {
      capabilities: {
        hoverProvider: true,
        definitionProvider: true,
        documentLinkProvider: { resolveProvider: false },
        textDocumentSync: 1,
      },
    };
  });

  function reportEvicted() {
    const evicted = workspace.takeEvicted();
    if (evicted.length > 0) connection.sendNotification('yaml-dsl/evicted', { stackIds: evicted });
  }

  function watchSchemas() {
    if (!watchesFiles) return;
    const watchTargets = workspace.schemaWatchTargets();
    const targetKey = watchTargets
      .map((watchTarget) => `${watchTarget.base}\n${watchTarget.pattern}`)
      .sort()
      .join('\n');
    if (targetKey === watchKey) return;
    watchKey = targetKey;
    const previousRegistration = watchRegistration;
    watchRegistration = watchTargets.length === 0 ? null : connection.client.register(
      DidChangeWatchedFilesNotification.type,
      {
        watchers: watchTargets.map((watchTarget) => ({
          globPattern: { baseUri: pathToUri(watchTarget.base), pattern: watchTarget.pattern },
        })),
      },
    ).catch(() => null);
    if (previousRegistration) previousRegistration.then((disposable) => disposable && disposable.dispose());
  }

  function reportReanalyzed() {
    const reanalyzedUris = workspace.takeReanalyzedUris();
    if (reanalyzedUris.length > 0) connection.sendNotification('yaml-dsl/reanalyzed', { uris: reanalyzedUris });
  }

  function settle() {
    reportEvicted();
    watchSchemas();
    reportReanalyzed();
  }

  const inflight = new Set();

  function track(job) {
    const pending = Promise.resolve(job).catch(() => {});
    inflight.add(pending);
    pending.finally(() => inflight.delete(pending));
  }

  function whenIdle() {
    if (inflight.size === 0) return Promise.resolve();
    return Promise.all([...inflight]).then(() => whenIdle());
  }

  function onDocument(document) {
    const filePath = document.uri.startsWith('file://') ? uriToPath(document.uri) : document.uri;
    track(workspace.sync(document.uri, filePath, document.getText()).then(settle));
  }

  documents.onDidOpen((event) => onDocument(event.document));
  documents.onDidChangeContent((event) => onDocument(event.document));
  documents.onDidClose((event) => {
    workspace.close(event.document.uri);
  });

  connection.onHover((params) => workspace.hover(params.textDocument.uri, params.position));
  connection.onDefinition((params) => {
    const hit = workspace.definition(params.textDocument.uri, params.position);
    if (!hit) return null;
    return {
      originSelectionRange: hit.origin,
      targetUri: pathToUri(hit.path),
      targetRange: hit.range,
      targetSelectionRange: hit.range,
    };
  });
  connection.onDocumentLinks((params) => workspace.links(params.textDocument.uri).map((link) => ({
    range: link.range,
    target: linkTarget(link.path, link.targetRange),
  })));

  connection.onNotification('yaml-dsl/config', async (params) => {
    const entries = params.entries || [{ text: params.text, dir: params.dir }];
    await workspace.setConfigs(entries);
    settle();
  });
  connection.onNotification('yaml-dsl/active', (params) => {
    track(workspace.setActive(params.path).then(settle));
  });
  connection.onNotification('yaml-dsl/warm', (params) => {
    track(workspace.warm(params.paths || []).then(settle));
  });
  connection.onNotification('yaml-dsl/visibleFolds', (params) => {
    workspace.setVisibleFolds(params.stackIds || []);
    reportEvicted();
    watchSchemas();
  });
  connection.onDidChangeWatchedFiles((params) => {
    const changedPaths = (params.changes || []).map((change) => uriToPath(change.uri));
    track(workspace.schemasChanged(changedPaths).then(settle));
  });
  connection.onRequest('yaml-dsl/fold', (params) => workspace.foldText(params.stackId, params.env));
  connection.onRequest('yaml-dsl/foldsFor', (params) => workspace.foldsFor(params.path));
  connection.onRequest('yaml-dsl/decorations', (params) => workspace.decorations(params.uri));
  workspace.whenIdle = whenIdle;
  return workspace;
}

module.exports = { bind };

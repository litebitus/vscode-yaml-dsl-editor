const { createWorkspace } = require('./workspace');
const { readFileOrNull, fetchTextOrNull } = require('./io');
const { pathToUri, uriToPath, linkTarget } = require('./analyze');

function bind(connection, documents, options = {}) {
  const workspace = options.workspace || createWorkspace({
    readFile: options.readFile || readFileOrNull,
    fetchText: options.fetchText || fetchTextOrNull,
  });

  connection.onInitialize(() => ({
    capabilities: {
      hoverProvider: true,
      definitionProvider: true,
      documentLinkProvider: { resolveProvider: false },
      textDocumentSync: 1,
    },
  }));

  async function publish(uri) {
    connection.sendDiagnostics({ uri, diagnostics: workspace.diagnostics(uri) });
  }

  async function publishAll() {
    for (const uri of workspace.openUris()) await publish(uri);
  }

  function reportEvicted() {
    const evicted = workspace.takeEvicted();
    if (evicted.length > 0) connection.sendNotification('yaml-dsl/evicted', { stackIds: evicted });
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
    track(workspace.sync(document.uri, filePath, document.getText()).then(() => {
      reportEvicted();
      return publishAll();
    }));
  }

  documents.onDidOpen((event) => onDocument(event.document));
  documents.onDidChangeContent((event) => onDocument(event.document));
  documents.onDidClose((event) => {
    workspace.close(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
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
    reportEvicted();
    await publishAll();
  });
  connection.onNotification('yaml-dsl/active', (params) => {
    track(workspace.setActive(params.path).then(() => {
      reportEvicted();
      return publishAll();
    }));
  });
  connection.onNotification('yaml-dsl/warm', (params) => {
    track(workspace.warm(params.paths || []).then(() => {
      reportEvicted();
      return publishAll();
    }));
  });
  connection.onNotification('yaml-dsl/visibleFolds', (params) => {
    workspace.setVisibleFolds(params.stackIds || []);
    reportEvicted();
  });
  connection.onRequest('yaml-dsl/fold', (params) => workspace.foldText(params.stackId, params.env));
  connection.onRequest('yaml-dsl/foldsFor', (params) => workspace.foldsFor(params.path));
  workspace.whenIdle = whenIdle;
  return workspace;
}

module.exports = { bind };

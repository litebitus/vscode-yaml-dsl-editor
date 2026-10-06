const {
  CompletionItemKind,
  DidChangeWatchedFilesNotification,
  SemanticTokensBuilder,
} = require('vscode-languageserver/node');
const { createWorkspace } = require('./workspace');
const { readFileOrNull, fetchTextOrNull, terraformFunctionsOrNull } = require('./io');
const {
  pathToUri,
  uriToPath,
  linkTarget,
  TOKEN_TYPES,
  TOKEN_MODIFIERS,
} = require('./analyze');
const COMPLETION_KINDS = {
  builtin: CompletionItemKind.Constant,
  function: CompletionItemKind.Function,
  value: CompletionItemKind.Variable,
};

function encodedTokens(tokens) {
  const builder = new SemanticTokensBuilder();
  for (const token of tokens) {
    const modifierBits = token.modifiers
      .reduce((bits, modifier) => bits | (1 << TOKEN_MODIFIERS.indexOf(modifier)), 0);
    builder.push(token.line, token.character, token.length, TOKEN_TYPES.indexOf(token.type), modifierBits);
  }
  return builder.build();
}

function bind(connection, documents, options = {}) {
  const workspace = options.workspace || createWorkspace({
    readFile: options.readFile || readFileOrNull,
    fetchText: options.fetchText || fetchTextOrNull,
    terraformFunctions: options.terraformFunctions || terraformFunctionsOrNull,
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
        completionProvider: { triggerCharacters: [' ', '.', '{'] },
        semanticTokensProvider: {
          legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS },
          full: true,
        },
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
    if (reanalyzedUris.length === 0) return;
    connection.sendNotification('yaml-dsl/reanalyzed', { uris: reanalyzedUris });
    connection.languages.semanticTokens.refresh();
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

  function answeredAfterAnalysis(uriOf, answer) {
    return async (params) => {
      await workspace.whenAnalyzed(uriOf(params));
      return answer(params);
    };
  }

  const documentUri = (params) => params.textDocument.uri;

  connection.onHover(answeredAfterAnalysis(documentUri, (params) => workspace.hover(documentUri(params), params.position)));
  connection.onDefinition(answeredAfterAnalysis(documentUri, (params) => {
    const hit = workspace.definition(documentUri(params), params.position);
    if (!hit) return null;
    return {
      originSelectionRange: hit.origin,
      targetUri: pathToUri(hit.path),
      targetRange: hit.range,
      targetSelectionRange: hit.range,
    };
  }));
  connection.onCompletion(answeredAfterAnalysis(documentUri, (params) => workspace
    .completion(documentUri(params), params.position)
    .map((item) => ({
      label: item.label,
      kind: COMPLETION_KINDS[item.kind] || CompletionItemKind.Reference,
      detail: item.detail,
      documentation: item.documentation ? { kind: 'markdown', value: item.documentation } : undefined,
      filterText: item.label,
      textEdit: { range: item.range, newText: item.label },
    }))));
  connection.languages.semanticTokens.on(answeredAfterAnalysis(
    documentUri,
    (params) => encodedTokens(workspace.semanticTokens(documentUri(params))),
  ));
  connection.onDocumentLinks(answeredAfterAnalysis(documentUri, (params) => workspace
    .links(documentUri(params))
    .map((link) => ({
      range: link.range,
      target: linkTarget(link.path, link.targetRange),
    }))));

  connection.onNotification('yaml-dsl/config', async (params) => {
    const entries = params.entries || [{ text: params.text, dir: params.dir }];
    await workspace.setConfigs(entries);
    settle();
    connection.languages.semanticTokens.refresh();
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
  connection.onRequest('yaml-dsl/fold', (params) => workspace.foldText(params.stackId, params.overlayName));
  connection.onRequest('yaml-dsl/foldsFor', (params) => workspace.foldsFor(params.path));
  connection.onRequest('yaml-dsl/decorations', answeredAfterAnalysis(
    (params) => params.uri,
    (params) => workspace.decorations(params.uri),
  ));
  workspace.onVocabularyLoaded(settle);
  workspace.whenIdle = whenIdle;
  return workspace;
}

module.exports = { bind };

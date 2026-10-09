function createInlayHintRegistration(vscode, selector, hintsOf) {
  const hintsChanged = new vscode.EventEmitter();
  const emptyAnsweredUris = new Set();
  const provider = {
    onDidChangeInlayHints: hintsChanged.event,
    provideInlayHints: (document) => {
      const hints = hintsOf(document);
      const key = document.uri.toString();
      if (hints.length === 0) emptyAnsweredUris.add(key);
      else emptyAnsweredUris.delete(key);
      return hints;
    },
  };
  let registration = null;
  const register = () => {
    if (registration) registration.dispose();
    registration = vscode.languages.registerInlayHintsProvider(selector, provider);
  };
  register();
  return {
    refreshHints(hasHints) {
      if ([...emptyAnsweredUris].some(hasHints)) register();
      else hintsChanged.fire();
    },
    forgetUri(uri) {
      emptyAnsweredUris.delete(uri);
    },
    dispose() {
      registration.dispose();
      hintsChanged.dispose();
    },
  };
}

module.exports = { createInlayHintRegistration };

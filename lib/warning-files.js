const WARNING_BADGE = '⚠';
const WARNING_THEME_COLOR = 'yamlDslEditor.warningForeground';

function createWarningFiles() {
  const urisByStack = new Map();

  function replaceStack(stackId, uris) {
    const changedUris = new Set([...(urisByStack.get(stackId) || []), ...uris]);
    urisByStack.set(stackId, new Set(uris));
    return [...changedUris];
  }

  function holdsWarning(uri) {
    return [...urisByStack.values()].some((uris) => uris.has(uri));
  }

  function fileDecoration(vscode, uri) {
    if (!holdsWarning(uri.toString())) return undefined;
    const decoration = new vscode.FileDecoration(WARNING_BADGE, undefined, new vscode.ThemeColor(WARNING_THEME_COLOR));
    decoration.propagate = true;
    return decoration;
  }

  return { replaceStack, holdsWarning, fileDecoration };
}

module.exports = { WARNING_BADGE, WARNING_THEME_COLOR, createWarningFiles };

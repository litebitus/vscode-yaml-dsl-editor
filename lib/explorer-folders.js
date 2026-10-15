function withAncestorFolders(uris) {
  const withFolders = new Set(uris);
  for (const uri of uris) {
    let current = uri;
    for (;;) {
      const parent = current.slice(0, current.lastIndexOf('/'));
      if (parent.length === 0 || parent.endsWith(':/') || parent.endsWith('://')) break;
      withFolders.add(parent);
      current = parent;
    }
  }
  return [...withFolders];
}

function explorerUriSets(fileUris) {
  const files = new Set(fileUris);
  const folders = new Set(withAncestorFolders([...files]).filter((uri) => !files.has(uri)));
  return { files, folders };
}

function explorerDecoration(vscode, { badge, themeColor, uriSets, uri }) {
  const uriKey = uri.toString();
  if (uriSets.files.has(uriKey)) {
    const decoration = new vscode.FileDecoration(badge, undefined, new vscode.ThemeColor(themeColor));
    decoration.propagate = true;
    return decoration;
  }
  return uriSets.folders.has(uriKey) ? new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(themeColor)) : undefined;
}

module.exports = { withAncestorFolders, explorerUriSets, explorerDecoration };

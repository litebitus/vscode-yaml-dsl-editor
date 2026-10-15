function folderHoldsAny(folderUri, fileUris) {
  const folderPrefix = folderUri.endsWith('/') ? folderUri : `${folderUri}/`;
  return fileUris.some((fileUri) => fileUri.startsWith(folderPrefix));
}

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

function explorerDecoration(vscode, { badge, themeColor, fileUris, uri }) {
  const uriKey = uri.toString();
  const color = new vscode.ThemeColor(themeColor);
  if (fileUris.includes(uriKey)) {
    const decoration = new vscode.FileDecoration(badge, undefined, color);
    decoration.propagate = true;
    return decoration;
  }
  return folderHoldsAny(uriKey, fileUris) ? new vscode.FileDecoration(undefined, undefined, color) : undefined;
}

module.exports = { folderHoldsAny, withAncestorFolders, explorerDecoration };

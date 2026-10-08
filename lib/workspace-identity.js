const { textHashOf } = require('./text-hash');

function workspaceIdentityOf(workspace) {
  if (workspace.workspaceFile) return workspace.workspaceFile.toString();
  const folders = workspace.workspaceFolders || [];
  return folders.length === 1 ? folders[0].uri.toString() : null;
}

function workspaceStorageNameOf(workspace) {
  const identity = workspaceIdentityOf(workspace);
  return identity === null ? null : textHashOf(identity);
}

module.exports = { workspaceIdentityOf, workspaceStorageNameOf };

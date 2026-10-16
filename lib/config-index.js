const path = require('path');
const { CONFIG_FILE_NAME, insideDir } = require('./config');

function createConfigIndex(vscode) {
  const configTextByDir = new Map();

  function workspaceFolderDirs() {
    return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  }

  function workspaceFolderDirOf(filePath) {
    return workspaceFolderDirs()
      .filter((dir) => insideDir(filePath, dir))
      .reduce((deepest, dir) => (deepest === null || dir.length > deepest.length ? dir : deepest), null);
  }

  async function configTextIn(dir) {
    try {
      const configUri = vscode.Uri.joinPath(vscode.Uri.file(dir), CONFIG_FILE_NAME);
      return Buffer.from(await vscode.workspace.fs.readFile(configUri)).toString('utf8');
    } catch {
      return null;
    }
  }

  async function readDir(dir) {
    configTextByDir.set(dir, await configTextIn(dir));
  }

  async function readWorkspaceFolders() {
    await Promise.all(workspaceFolderDirs().map(readDir));
  }

  async function learnConfigsAbove(filePath) {
    const workspaceDir = workspaceFolderDirOf(filePath);
    if (workspaceDir === null) return false;
    const unreadDirs = [];
    for (let dir = path.dirname(filePath); insideDir(dir, workspaceDir); dir = path.dirname(dir)) {
      if (!configTextByDir.has(dir)) unreadDirs.push(dir);
      if (dir === workspaceDir) break;
    }
    await Promise.all(unreadDirs.map(readDir));
    return unreadDirs.some((dir) => configTextByDir.get(dir) !== null);
  }

  async function reread(changedConfigPaths = []) {
    const workspaceDirs = workspaceFolderDirs();
    const insideWorkspace = (dir) => workspaceDirs.some((workspaceDir) => insideDir(dir, workspaceDir));
    for (const dir of [...configTextByDir.keys()]) {
      if (!insideWorkspace(dir)) configTextByDir.delete(dir);
    }
    const dirs = new Set([
      ...workspaceDirs,
      ...[...configTextByDir.keys()].filter((dir) => configTextByDir.get(dir) !== null),
      ...changedConfigPaths.map((configPath) => path.dirname(configPath)).filter(insideWorkspace),
    ]);
    await Promise.all([...dirs].map(readDir));
  }

  function entries() {
    return [...configTextByDir]
      .filter(([, text]) => text !== null)
      .map(([dir, text]) => ({ text, dir }));
  }

  return { readWorkspaceFolders, learnConfigsAbove, reread, entries };
}

module.exports = { createConfigIndex };

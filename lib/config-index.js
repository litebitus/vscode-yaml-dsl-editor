const path = require('path');
const { CONFIG_FILE_NAME, insideDir } = require('./config');

const LISTED_CONFIGS_CAPACITY = 1000;

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

  function insideWorkspace(dir) {
    return workspaceFolderDirs().some((workspaceDir) => insideDir(dir, workspaceDir));
  }

  async function listedConfigDirs() {
    if (!vscode.workspace.findFiles) return [];
    const listed = await vscode.workspace.findFiles(`**/${CONFIG_FILE_NAME}`, undefined, LISTED_CONFIGS_CAPACITY);
    return listed.map((uri) => path.dirname(uri.fsPath)).filter(insideWorkspace);
  }

  async function readWorkspaceFolderConfigs() {
    await Promise.all(workspaceFolderDirs().map(readDir));
  }

  async function readListedConfigs() {
    const unreadDirs = (await listedConfigDirs()).filter((dir) => !configTextByDir.has(dir));
    await Promise.all(unreadDirs.map(readDir));
    return unreadDirs.some((dir) => configTextByDir.get(dir) !== null);
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

  return { readWorkspaceFolderConfigs, readListedConfigs, learnConfigsAbove, reread, entries };
}

module.exports = { createConfigIndex };

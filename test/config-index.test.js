const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigIndex } = require('../lib/config-index');

function fakeVscode(configTextByPath, folders = ['/mock-repo'], listedConfigPaths = []) {
  const reads = [];
  const searches = [];
  const vscode = {
    reads,
    searches,
    Uri: {
      file: (fsPath) => ({ fsPath }),
      joinPath: (base, part) => ({ fsPath: `${base.fsPath}/${part}` }),
    },
    workspace: {
      workspaceFolders: folders.map((fsPath) => ({ uri: { fsPath } })),
      fs: {
        readFile: async (uri) => {
          reads.push(uri.fsPath);
          if (!configTextByPath.has(uri.fsPath)) throw new Error(`mock missing ${uri.fsPath}`);
          return Buffer.from(configTextByPath.get(uri.fsPath), 'utf8');
        },
      },
      findFiles: async (pattern, exclude, maxResults) => {
        searches.push({ pattern, maxResults });
        return listedConfigPaths.map((fsPath) => ({ fsPath }));
      },
    },
  };
  return vscode;
}

test('startup reads each workspace folder\'s config and every config the workspace lists, '
  + 'none outside it', async () => {
  const configs = new Map([
    ['/mock-repo/yaml-dsl.yml', 'outer'],
    ['/mock-repo/examples/mock-dsl/yaml-dsl.yml', 'inner'],
    ['/elsewhere/yaml-dsl.yml', 'stray'],
  ]);
  const vscode = fakeVscode(configs, ['/mock-repo'], [
    '/mock-repo/examples/mock-dsl/yaml-dsl.yml',
    '/elsewhere/yaml-dsl.yml',
  ]);
  const index = createConfigIndex(vscode);
  await index.readWorkspaceFolderConfigs();
  assert.deepEqual(vscode.reads, ['/mock-repo/yaml-dsl.yml']);
  assert.deepEqual(vscode.searches, []);
  assert.equal(await index.readListedConfigs(), true);
  assert.equal(vscode.searches.length, 1);
  assert.equal(vscode.searches[0].pattern, '**/yaml-dsl.yml');
  assert.equal(Number.isInteger(vscode.searches[0].maxResults), true);
  assert.deepEqual(vscode.reads, ['/mock-repo/yaml-dsl.yml', '/mock-repo/examples/mock-dsl/yaml-dsl.yml']);
  assert.deepEqual(index.entries(), [
    { text: 'outer', dir: '/mock-repo' },
    { text: 'inner', dir: '/mock-repo/examples/mock-dsl' },
  ]);
  assert.equal(await index.readListedConfigs(), false);
  assert.equal(vscode.reads.length, 2);
});

test('a config the workspace does not list is learned when a file below it opens', async () => {
  const configs = new Map([
    ['/mock-repo/yaml-dsl.yml', 'outer'],
    ['/mock-repo/examples/mock-dsl/yaml-dsl.yml', 'inner'],
  ]);
  const vscode = fakeVscode(configs);
  delete vscode.workspace.findFiles;
  const index = createConfigIndex(vscode);
  await index.readWorkspaceFolderConfigs();
  assert.equal(await index.readListedConfigs(), false);
  assert.deepEqual(vscode.reads, ['/mock-repo/yaml-dsl.yml']);
  assert.deepEqual(index.entries(), [{ text: 'outer', dir: '/mock-repo' }]);
  assert.equal(await index.learnConfigsAbove('/mock-repo/examples/mock-dsl/nested/mock.yaml'), true);
  assert.deepEqual(vscode.reads.slice(1).sort(), [
    '/mock-repo/examples/mock-dsl/nested/yaml-dsl.yml',
    '/mock-repo/examples/mock-dsl/yaml-dsl.yml',
    '/mock-repo/examples/yaml-dsl.yml',
  ]);
  assert.deepEqual(index.entries(), [
    { text: 'outer', dir: '/mock-repo' },
    { text: 'inner', dir: '/mock-repo/examples/mock-dsl' },
  ]);
  assert.equal(await index.learnConfigsAbove('/mock-repo/examples/mock-dsl/other.yaml'), false);
  assert.equal(vscode.reads.length, 4);
});

test('a file outside every workspace folder learns nothing', async () => {
  const vscode = fakeVscode(new Map([['/elsewhere/yaml-dsl.yml', 'stray']]));
  const index = createConfigIndex(vscode);
  assert.equal(await index.learnConfigsAbove('/elsewhere/mock.yaml'), false);
  assert.deepEqual(vscode.reads, []);
  assert.deepEqual(index.entries(), []);
});

test('a reread follows a changed, created or deleted config and drops folders left the workspace', async () => {
  const configs = new Map([['/mock-repo/yaml-dsl.yml', 'outer']]);
  const vscode = fakeVscode(configs, ['/mock-repo', '/mock-other']);
  const index = createConfigIndex(vscode);
  await index.readWorkspaceFolderConfigs();
  configs.set('/mock-repo/yaml-dsl.yml', 'outer changed');
  configs.set('/mock-repo/nested/yaml-dsl.yml', 'created');
  configs.set('/mock-other/yaml-dsl.yml', 'other');
  await index.reread(['/mock-repo/nested/yaml-dsl.yml']);
  assert.deepEqual(index.entries(), [
    { text: 'outer changed', dir: '/mock-repo' },
    { text: 'other', dir: '/mock-other' },
    { text: 'created', dir: '/mock-repo/nested' },
  ]);
  configs.delete('/mock-repo/nested/yaml-dsl.yml');
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/mock-repo' } }];
  await index.reread(['/mock-repo/nested/yaml-dsl.yml']);
  assert.deepEqual(index.entries(), [{ text: 'outer changed', dir: '/mock-repo' }]);
});

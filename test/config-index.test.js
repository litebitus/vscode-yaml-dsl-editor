const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfigIndex } = require('../lib/config-index');

function fakeVscode(configTextByPath, folders = ['/mock-repo']) {
  const reads = [];
  const vscode = {
    reads,
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
    },
  };
  return vscode;
}

test('startup reads only the workspace folders, and a file opened below learns the configs above it', async () => {
  const configs = new Map([
    ['/mock-repo/yaml-dsl.yml', 'outer'],
    ['/mock-repo/examples/mock-dsl/yaml-dsl.yml', 'inner'],
  ]);
  const vscode = fakeVscode(configs);
  const index = createConfigIndex(vscode);
  await index.readWorkspaceFolders();
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
  await index.readWorkspaceFolders();
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

const test = require('node:test');
const assert = require('node:assert/strict');
const { workspaceIdentityOf, workspaceStorageNameOf } = require('../lib/workspace-identity');
const { textHashOf } = require('../lib/text-hash');

const mockUri = (value) => ({ toString: () => value });
const mockFolder = (value) => ({ uri: mockUri(value) });

test('a workspace file identifies a multi-root workspace, and a lone folder identifies its own', () => {
  const workspaceFile = 'file:///mock/mock.code-workspace';
  const multiRoot = {
    workspaceFile: mockUri(workspaceFile),
    workspaceFolders: [mockFolder('file:///mock/a'), mockFolder('file:///mock/b')],
  };
  assert.equal(workspaceIdentityOf(multiRoot), workspaceFile);
  assert.equal(workspaceIdentityOf({ workspaceFolders: [mockFolder('file:///mock/a')] }), 'file:///mock/a');
});

test('a window without a workspace has no identity and no storage name', () => {
  assert.equal(workspaceIdentityOf({}), null);
  assert.equal(workspaceIdentityOf({ workspaceFolders: [] }), null);
  assert.equal(workspaceStorageNameOf({ workspaceFolders: [] }), null);
});

test('the storage name is the hash of the identity, the same for the same workspace and distinct across workspaces', () => {
  const first = workspaceStorageNameOf({ workspaceFolders: [mockFolder('file:///mock/a')] });
  assert.equal(first, textHashOf('file:///mock/a'));
  assert.equal(workspaceStorageNameOf({ workspaceFolders: [mockFolder('file:///mock/a')] }), first);
  assert.notEqual(workspaceStorageNameOf({ workspaceFolders: [mockFolder('file:///mock/b')] }), first);
});

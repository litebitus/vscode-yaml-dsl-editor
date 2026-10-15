const test = require('node:test');
const assert = require('node:assert/strict');
const { folderHoldsAny, withAncestorFolders } = require('../lib/explorer-folders');

test('a folder holds the files below it at any depth, and never a sibling sharing its name\'s start', () => {
  const fileUris = ['file:///repo/stack/dev/mock.yml'];
  assert.equal(folderHoldsAny('file:///repo/stack', fileUris), true);
  assert.equal(folderHoldsAny('file:///repo/stack/', fileUris), true);
  assert.equal(folderHoldsAny('file:///repo/sta', fileUris), false);
  assert.equal(folderHoldsAny('file:///repo/stack/dev/mock.yml', fileUris), false);
});

test('a changed file brings every folder above it, once', () => {
  assert.deepEqual(withAncestorFolders(['file:///repo/dev/mock.yml', 'file:///repo/staging/mock.yml']), [
    'file:///repo/dev/mock.yml',
    'file:///repo/staging/mock.yml',
    'file:///repo/dev',
    'file:///repo',
    'file:///repo/staging',
  ]);
});

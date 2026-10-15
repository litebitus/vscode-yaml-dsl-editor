const test = require('node:test');
const assert = require('node:assert/strict');
const { withAncestorFolders, explorerUriSets } = require('../lib/explorer-folders');

test('the folder set holds every folder above a file, and never a sibling sharing its name\'s start', () => {
  const sets = explorerUriSets(['file:///repo/stack/dev/mock.yml']);
  assert.deepEqual([...sets.files], ['file:///repo/stack/dev/mock.yml']);
  assert.deepEqual([...sets.folders], ['file:///repo/stack/dev', 'file:///repo/stack', 'file:///repo']);
  assert.equal(sets.folders.has('file:///repo/sta'), false);
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

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchGlob, matchAny } = require('../lib/glob');

test('globs match resources files at the root and in nested directories', () => {
  assert.equal(matchGlob('**/mock.yml', 'mock.yml'), true);
  assert.equal(matchGlob('**/mock.yml', 'mock-stack/mock.yml'), true);
  assert.equal(matchGlob('**/mock.yml', 'mock-stack/one/mock.yml'), true);
  assert.equal(matchGlob('*.yml', 'a.yml'), true);
  assert.equal(matchGlob('*.yml', 'dir/a.yml'), false);
  assert.equal(matchGlob('a**b', 'axxxb'), true);
  assert.equal(matchGlob('file.name', 'file.name'), true);
  assert.equal(matchGlob('file.name', 'fileXname'), false);
  assert.equal(matchGlob('**/mock.yml', 'a\\b\\mock.yml'), true);
  assert.equal(matchAny(['*.yml', '**/mock.yml'], 'a/mock.yml'), true);
  assert.equal(matchAny(['*.json'], 'a.yml'), false);
});

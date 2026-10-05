const test = require('node:test');
const assert = require('node:assert/strict');
const { matchGlob, matchAny } = require('../lib/glob');

test('globs match resources files at the root and in nested directories', () => {
  assert.equal(matchGlob('**/resources.yml', 'resources.yml'), true);
  assert.equal(matchGlob('**/resources.yml', 'rds/datahub/resources.yml'), true);
  assert.equal(matchGlob('**/resources.yml', 'rds/datahub/dev/resources.yml'), true);
  assert.equal(matchGlob('*.yml', 'a.yml'), true);
  assert.equal(matchGlob('*.yml', 'dir/a.yml'), false);
  assert.equal(matchGlob('a**b', 'axxxb'), true);
  assert.equal(matchGlob('file.name', 'file.name'), true);
  assert.equal(matchGlob('file.name', 'fileXname'), false);
  assert.equal(matchGlob('**/resources.yml', 'a\\b\\resources.yml'), true);
  assert.equal(matchAny(['*.yml', '**/resources.yml'], 'a/resources.yml'), true);
  assert.equal(matchAny(['*.json'], 'a.yml'), false);
});

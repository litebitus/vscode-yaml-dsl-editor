const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compiledSchemaFileOf, compiledSchemaFileStore } = require('../lib/compiled-schema-files');

const MOCK_HEADER = { schemaHash: 'mock-schema-hash', buildKey: 'mock-build-key' };

function mockStorageFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-storage-'));
}

test('each DSL entry has its own compiled schema file in the storage folder', () => {
  const file = compiledSchemaFileOf('/mock/storage', '/mock/config', 'mock-dsl');
  assert.equal(path.dirname(file), path.join('/mock/storage', 'compiled-schemas'));
  assert.match(path.basename(file), /^[0-9a-f]{32}\.js$/);
  assert.equal(compiledSchemaFileOf('/mock/storage', '/mock/config', 'mock-dsl'), file);
  assert.notEqual(compiledSchemaFileOf('/mock/storage', '/mock/config', 'mock-other-dsl'), file);
  assert.notEqual(compiledSchemaFileOf('/mock/storage', '/mock/other-config', 'mock-dsl'), file);
});

test('a saved compiled schema is loaded only for the same schema and build', () => {
  const file = compiledSchemaFileOf(mockStorageFolder(), '/mock/config', 'mock-dsl');
  const problems = [];
  const store = compiledSchemaFileStore(file, MOCK_HEADER, (message) => problems.push(message));
  assert.equal(store.filename, file);
  assert.equal(store.load(), null);
  store.save('module.exports = function mockValidate() { return true; };');
  assert.equal(store.load(), 'module.exports = function mockValidate() { return true; };');
  assert.equal(fs.existsSync(`${file}.writing`), false);
  const otherSchema = compiledSchemaFileStore(file, { ...MOCK_HEADER, schemaHash: 'mock-other' }, () => {});
  const otherBuild = compiledSchemaFileStore(file, { ...MOCK_HEADER, buildKey: 'mock-other' }, () => {});
  assert.equal(otherSchema.load(), null);
  assert.equal(otherBuild.load(), null);
  otherSchema.save('module.exports = null;');
  assert.equal(otherSchema.load(), 'module.exports = null;');
  assert.equal(store.load(), null);
  assert.deepEqual(problems, []);
});

test('a compiled schema that cannot be saved is reported, not thrown', () => {
  const folderThatIsAFile = path.join(mockStorageFolder(), 'mock-file');
  fs.writeFileSync(folderThatIsAFile, 'mock');
  const problems = [];
  const store = compiledSchemaFileStore(path.join(folderThatIsAFile, 'mock.js'), MOCK_HEADER, (message) => {
    problems.push(message);
  });
  store.save('module.exports = null;');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^the compiled schema could not be saved to .*mock\.js: /);
  assert.equal(store.load(), null);
});

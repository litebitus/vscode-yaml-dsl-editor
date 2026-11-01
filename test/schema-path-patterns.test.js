const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { firstMatchingFile, literalFolderOf } = require('../lib/schema-path-patterns');

let root = null;

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-path-patterns-'));
});

test.afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative, text) {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('a pattern takes the first file it matches, in path order', async () => {
  write('.terraform/modules/queue_b/mock.schema.json', '{}');
  write('.terraform/modules/key_a/mock.schema.json', '{}');
  write('.terraform/modules/key_a/other.json', '{}');
  const pattern = path.join(root, '.terraform/modules/*/mock.schema.json');
  assert.equal(await firstMatchingFile(pattern), path.join(root, '.terraform/modules/key_a/mock.schema.json'));
  assert.equal(await firstMatchingFile(path.join(root, 'missing/*/mock.schema.json')), null);
});

test('a pattern with no match is watched from the folder above its first pattern step', () => {
  assert.equal(literalFolderOf('/repo/stack/.terraform/modules/*/mock.schema.json'), '/repo/stack/.terraform/modules');
});

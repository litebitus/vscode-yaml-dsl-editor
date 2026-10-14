const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extensionBuildHashOf } = require('../lib/extension-build');

function mockExtensionFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-build-'));
  fs.mkdirSync(path.join(folder, 'lib', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), '{"name":"mock-extension"}');
  fs.writeFileSync(path.join(folder, 'extension.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(folder, 'lib', 'mock-module.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(folder, 'lib', 'nested', 'mock-nested.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(folder, 'README.md'), '# mock\n');
  return folder;
}

test('the build hash changes with the manifest or any code file, and with nothing else', async () => {
  const folder = mockExtensionFolder();
  const original = await extensionBuildHashOf(folder);
  assert.equal(await extensionBuildHashOf(folder), original);
  fs.writeFileSync(path.join(folder, 'README.md'), '# mock edited\n');
  assert.equal(await extensionBuildHashOf(folder), original);
  const changes = [
    ['package.json', '{"name":"mock-extension","version":"0.0.1"}'],
    ['extension.js', 'module.exports = 10;\n'],
    [path.join('lib', 'mock-module.js'), 'module.exports = 20;\n'],
    [path.join('lib', 'nested', 'mock-nested.js'), 'module.exports = 30;\n'],
  ];
  const seen = new Set([original]);
  for (const [relativePath, text] of changes) {
    fs.writeFileSync(path.join(folder, relativePath), text);
    const changed = await extensionBuildHashOf(folder);
    assert.equal(seen.has(changed), false, relativePath);
    seen.add(changed);
  }
  fs.writeFileSync(path.join(folder, 'lib', 'added-module.js'), '');
  assert.equal(seen.has(await extensionBuildHashOf(folder)), false);
});

test('an extension folder that cannot be read fails the hash', async () => {
  await assert.rejects(extensionBuildHashOf(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-missing-folder')));
});

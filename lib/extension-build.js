const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_FOLDER = 'lib';
const MANIFEST_FILE = 'package.json';

async function codeFilePathsOf(extensionFolder) {
  const topLevel = (await fs.promises.readdir(extensionFolder)).filter((name) => name.endsWith('.js'));
  const codeFolder = path.join(extensionFolder, CODE_FOLDER);
  const nested = (await fs.promises.readdir(codeFolder, { recursive: true }))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(CODE_FOLDER, name));
  return [MANIFEST_FILE, ...topLevel, ...nested].sort();
}

async function extensionBuildHashOf(extensionFolder) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of await codeFilePathsOf(extensionFolder)) {
    hash.update(`${relativePath}\0`);
    hash.update(await fs.promises.readFile(path.join(extensionFolder, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = { extensionBuildHashOf };

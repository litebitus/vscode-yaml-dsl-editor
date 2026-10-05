const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readFileOrNull, fetchTextOrNull } = require('../lib/io');

test('reading a missing file and a failed fetch yield null', async () => {
  const file = path.join(os.tmpdir(), `yaml-dsl-${process.pid}.txt`);
  await fs.promises.writeFile(file, 'hello');
  assert.equal(await readFileOrNull(file), 'hello');
  assert.equal(await readFileOrNull(file + '.missing'), null);
  await fs.promises.unlink(file);
  assert.equal(await fetchTextOrNull('https://example.test/a', async () => ({ ok: true, text: async () => 'body' })), 'body');
  assert.equal(await fetchTextOrNull('https://example.test/b', async () => ({ ok: false, text: async () => '' })), null);
  assert.equal(await fetchTextOrNull('https://example.test/c', async () => { throw new Error('down'); }), null);
});

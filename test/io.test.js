const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readFileOrNull, fetchTextOrNull, terraformFunctionsOrNull } = require('../lib/io');

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

test("Terraform's function metadata is read from its JSON answer, and any failure is null", async () => {
  const answering = (error, stdout) => (command, args, options, callback) => {
    assert.equal(command, 'terraform');
    assert.deepEqual(args, ['metadata', 'functions', '-json']);
    assert.ok(options.timeout > 0);
    callback(error, stdout);
  };
  const metadata = await terraformFunctionsOrNull(answering(null, '{"format_version":"1.0"}'));
  assert.deepEqual(metadata, { format_version: '1.0' });
  assert.equal(await terraformFunctionsOrNull(answering(new Error('missing'), '')), null);
  assert.equal(await terraformFunctionsOrNull(answering(null, 'not json')), null);
});

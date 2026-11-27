const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readFileOrNull,
  fileStatOrNull,
  terraformFunctionsOrNull,
} = require('../lib/io');

test('a file\'s stat is its modification time and size, and a missing file\'s is null', async (t) => {
  const file = path.join(os.tmpdir(), `yaml-dsl-stat-${process.pid}.txt`);
  t.after(() => fs.promises.rm(file, { force: true }));
  await fs.promises.writeFile(file, 'mock-content');
  const written = await fs.promises.stat(file);
  assert.deepEqual(await fileStatOrNull(file), { modifiedMilliseconds: written.mtimeMs, size: 12 });
  assert.equal(await fileStatOrNull(`${file}.missing`), null);
});

test('reading a missing file yields null', async () => {
  const file = path.join(os.tmpdir(), `yaml-dsl-${process.pid}.txt`);
  await fs.promises.writeFile(file, 'hello');
  assert.equal(await readFileOrNull(file), 'hello');
  assert.equal(await readFileOrNull(file + '.missing'), null);
  await fs.promises.unlink(file);
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

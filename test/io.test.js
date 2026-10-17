const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readFileOrNull, fetchResponseOrNull, fetchTextOrNull, terraformFunctionsOrNull } = require('../lib/io');
const { mockSchemaServer } = require('./mock-schema-server');

const schemaServer = mockSchemaServer();
test.before(() => schemaServer.start());
test.after(() => schemaServer.stop());

test('reading a missing file and a failed fetch yield null', async () => {
  const file = path.join(os.tmpdir(), `yaml-dsl-${process.pid}.txt`);
  await fs.promises.writeFile(file, 'hello');
  assert.equal(await readFileOrNull(file), 'hello');
  assert.equal(await readFileOrNull(file + '.missing'), null);
  await fs.promises.unlink(file);
  schemaServer.serve('/mock.json', { text: 'body', entityTag: '"mock-tag"' });
  assert.equal(await fetchTextOrNull(schemaServer.urlOf('/mock.json')), 'body');
  assert.equal(await fetchTextOrNull(schemaServer.urlOf('/missing.json')), null);
  assert.equal(await fetchTextOrNull('http://127.0.0.1:1/unreachable.json'), null);
});

test('a fetch answers its status, its body only with a 200, and the validators the server sends', async () => {
  schemaServer.serve('/tagged.json', {
    text: 'tagged',
    entityTag: '"mock-tag"',
    lastModified: 'Mon, 05 Oct 2026 00:00:00 GMT',
  });
  assert.deepEqual(await fetchResponseOrNull(schemaServer.urlOf('/tagged.json')), {
    status: 200,
    text: 'tagged',
    entityTag: '"mock-tag"',
    lastModified: 'Mon, 05 Oct 2026 00:00:00 GMT',
  });
  const unchanged = await fetchResponseOrNull(schemaServer.urlOf('/tagged.json'), { 'If-None-Match': '"mock-tag"' });
  assert.deepEqual([unchanged.status, unchanged.text], [304, null]);
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

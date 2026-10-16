const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspace } = require('../lib/workspace');
const { createInProcessValidation, createWorkerValidation } = require('../lib/validation-requests');
const { compiledSchemaFileOf } = require('../lib/compiled-schema-files');
const { dslEntry, configText } = require('./config-builders');

const MOCK_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { name: { type: 'string' } },
});
const SCHEMA_PATH = '/repo/mock.schema.json';

const MOCK_FILE_TEXT = 'name: 1\n';

function mockWorkspace(createValidation) {
  return createWorkspace({
    readFile: async (filePath) => (filePath === SCHEMA_PATH ? MOCK_SCHEMA_TEXT : MOCK_FILE_TEXT),
    fetchText: async () => null,
    createValidation,
  });
}

function mockConfigs(...entries) {
  return [{ text: configText(...entries), dir: '/repo' }];
}

const messagesOf = (problems) => problems.map((problem) => problem.message);

test('with validation in the worker, a file\'s schema problems arrive when answered and the file is analyzed again, '
  + 'and only an opted-in DSL keeps its compiled schema', async () => {
  const storageFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-storage-'));
  const ws = mockWorkspace(() => createWorkerValidation());
  ws.setCompiledSchemaFolder(storageFolder);
  let answers = 0;
  ws.onValidationAnswered(() => { answers += 1; });
  await ws.setConfigs(mockConfigs(
    dslEntry('mock-kept', {
      file_includes: ['{config_root}/kept/**/mock.yml'],
      schema_search_paths: ['{config_root}/mock.schema.json'],
      performance: { compiled_schema_cache: true },
    }),
    dslEntry('mock-plain', {
      file_includes: ['{config_root}/plain/**/mock.yml'],
      schema_search_paths: ['{config_root}/mock.schema.json'],
    }),
  ));
  for (const folder of ['kept', 'plain']) {
    const filePath = `/repo/${folder}/mock.yml`;
    const uri = `file://${filePath}`;
    await ws.sync(uri, filePath, 'name: 1\n');
    ws.takeReanalyzedUris();
    assert.deepEqual(messagesOf(ws.problems(uri)), []);
    await ws.whenValidated();
    assert.ok(ws.takeReanalyzedUris().includes(uri));
    assert.deepEqual(messagesOf(ws.problems(uri)), ['`name` must be string']);
  }
  assert.equal(answers, 2);
  assert.equal(fs.existsSync(compiledSchemaFileOf(storageFolder, '/repo', 'mock-kept')), true);
  assert.equal(fs.existsSync(compiledSchemaFileOf(storageFolder, '/repo', 'mock-plain')), false);
  ws.dispose();
});

test('without a storage folder no compiled schema is kept', async () => {
  const requests = [];
  const ws = mockWorkspace(() => {
    const validation = createInProcessValidation();
    return { ...validation, problemsOf: (request) => requests.push(request) && validation.problemsOf(request) };
  });
  await ws.setConfigs(mockConfigs(dslEntry('mock-kept', {
    schema_search_paths: ['{config_root}/mock.schema.json'],
    performance: { compiled_schema_cache: true },
  })));
  await ws.sync('file:///repo/mock.yml', '/repo/mock.yml', 'name: 1\n');
  assert.deepEqual(messagesOf(ws.problems('file:///repo/mock.yml')), ['`name` must be string']);
  assert.equal(requests.at(-1).compiledSchemaFile, null);
  ws.dispose();
});

test('a file whose stack leaves the cache stops being validated, and a schema the cache drops is dropped', async () => {
  const dropped = { slots: [], schemas: [] };
  const folders = ['first', 'second', 'third'];
  const fileTextOf = (folder) => `# yaml-language-server: $schema=../${folder}.schema.json\nname: 1\n`;
  const ws = createWorkspace({
    readFile: async (filePath) => {
      const folder = folders.find((name) => filePath.includes(name));
      if (filePath.endsWith('.schema.json')) return JSON.stringify({ ...JSON.parse(MOCK_SCHEMA_TEXT), title: folder });
      return fileTextOf(folder);
    },
    fetchText: async () => null,
    createValidation: () => {
      const validation = createInProcessValidation();
      return {
        ...validation,
        dropSlot: (slot) => dropped.slots.push(slot),
        dropSchema: (schemaHash) => dropped.schemas.push(schemaHash),
      };
    },
  });
  await ws.setConfigs(mockConfigs(dslEntry('mock')));
  ws.setCacheCapacities({ stackCapacity: 1, schemaCapacity: 1 });
  for (const folder of folders) {
    const filePath = `/repo/${folder}/mock.yml`;
    await ws.setActive(filePath);
    await ws.sync(`file://${filePath}`, filePath, fileTextOf(folder));
    assert.deepEqual(messagesOf(ws.problems(`file://${filePath}`)), ['`name` must be string']);
    ws.close(`file://${filePath}`);
    await ws.setActive(null);
  }
  assert.ok(ws.takeEvicted().includes('/repo/first/mock.yml'));
  assert.ok(dropped.slots.includes('/repo/first/mock.yml'));
  assert.equal(dropped.slots.includes('/repo/third/mock.yml'), false);
  assert.equal(dropped.schemas.length > 0, true);
  ws.dispose();
});

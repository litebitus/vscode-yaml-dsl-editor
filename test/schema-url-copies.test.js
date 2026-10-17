const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { editorParametersOf, createSchemaUrlCopies } = require('../lib/schema-url-copies');
const { fetchResponseOrNull, fetchTextOrNull } = require('../lib/io');
const { createWorkspace } = require('../lib/workspace');
const { mockSchemaServer } = require('./mock-schema-server');
const { dslEntry, configText } = require('./config-builders');

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const schemaServer = mockSchemaServer();
test.before(() => schemaServer.start());
test.after(() => schemaServer.stop());
test.beforeEach(() => { schemaServer.requests.length = 0; });

function copiesAt(clock, storageFolder = null, logLines = []) {
  const copies = createSchemaUrlCopies({
    fetchText: fetchTextOrNull,
    fetchResponse: fetchResponseOrNull,
    logInfo: (line) => logLines.push(line),
    now: () => clock.time,
  });
  copies.setStorageFolder(storageFolder);
  return copies;
}

test('the editor\'s parameters leave the URL, and every other parameter stays as written and in order', () => {
  assert.deepEqual(editorParametersOf('https://example.test/mock.json'), {
    fetchUrl: 'https://example.test/mock.json',
    maxAgeDays: null,
    problem: null,
  });
  assert.deepEqual(editorParametersOf('https://example.test/mock.json?b=2&yaml_dsl_max_age_days=7&a=%20x&flag'), {
    fetchUrl: 'https://example.test/mock.json?b=2&a=%20x&flag',
    maxAgeDays: 7,
    problem: null,
  });
  assert.equal(editorParametersOf('https://example.test/mock.json?yaml_dsl_max_age_days=0').maxAgeDays, null);
  assert.equal(editorParametersOf('https://example.test/mock.json?yaml_dsl_max_age_days=0').fetchUrl,
    'https://example.test/mock.json');
  assert.equal(editorParametersOf('https://example.test/mock.json?yaml_dsl_max_age_days=1.5').problem,
    '`yaml_dsl_max_age_days` must be a whole number of days');
  assert.equal(editorParametersOf('https://example.test/mock.json?yaml_dsl_max_age_days').problem,
    '`yaml_dsl_max_age_days` must be a whole number of days');
  assert.equal(editorParametersOf('https://example.test/mock.json?yaml_dsl_ttl=7').problem,
    '`yaml_dsl_ttl` is not a parameter the editor reads');
});

test('a kept copy is used within its max age, then checked by its entity tag, and a 304 restarts its age', async () => {
  const clock = { time: 0 };
  const copies = copiesAt(clock);
  schemaServer.serve('/tagged.json', { text: 'first', entityTag: '"mock-first"' });
  const url = schemaServer.urlOf('/tagged.json?keep=1&yaml_dsl_max_age_days=2');
  assert.equal(await copies.schemaTextOf(url), 'first');
  clock.time = DAY_MILLISECONDS;
  assert.equal(await copies.schemaTextOf(url), 'first');
  assert.deepEqual(schemaServer.requests.map((request) => request.path), ['/tagged.json?keep=1']);
  clock.time = 3 * DAY_MILLISECONDS;
  assert.equal(await copies.schemaTextOf(url), 'first');
  assert.equal(schemaServer.requests[1].headers['if-none-match'], '"mock-first"');
  clock.time = 4 * DAY_MILLISECONDS;
  assert.equal(await copies.schemaTextOf(url), 'first');
  assert.equal(schemaServer.requests.length, 2);
  schemaServer.serve('/tagged.json', { text: 'second', entityTag: '"mock-second"' });
  clock.time = 6 * DAY_MILLISECONDS;
  assert.equal(await copies.schemaTextOf(url), 'second');
});

test('a copy with only a last-modified date is checked by it, and one with no validator is fetched whole', async () => {
  const clock = { time: 0 };
  const copies = copiesAt(clock);
  const lastModified = 'Mon, 05 Oct 2026 00:00:00 GMT';
  schemaServer.serve('/dated.json', { text: 'dated', lastModified });
  schemaServer.serve('/plain.json', { text: 'plain' });
  const datedUrl = schemaServer.urlOf('/dated.json?yaml_dsl_max_age_days=1');
  const plainUrl = schemaServer.urlOf('/plain.json?yaml_dsl_max_age_days=1');
  await copies.schemaTextOf(datedUrl);
  await copies.schemaTextOf(plainUrl);
  clock.time = 2 * DAY_MILLISECONDS;
  assert.equal(await copies.schemaTextOf(datedUrl), 'dated');
  assert.equal(await copies.schemaTextOf(plainUrl), 'plain');
  const checks = schemaServer.requests.slice(2);
  assert.equal(checks[0].headers['if-modified-since'], lastModified);
  assert.equal(checks[1].headers['if-modified-since'], undefined);
  assert.equal(checks[1].headers['if-none-match'], undefined);
});

test('a kept copy outlives the session in the storage folder, and stands in when the server is unreachable',
  async () => {
  const clock = { time: 0 };
  const storageFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-storage-'));
  const stoppingServer = mockSchemaServer();
  await stoppingServer.start();
  try {
    stoppingServer.serve('/kept.json', { text: 'kept', entityTag: '"mock-kept"' });
    const url = stoppingServer.urlOf('/kept.json?yaml_dsl_max_age_days=1');
    assert.equal(await copiesAt(clock, storageFolder).schemaTextOf(url), 'kept');
    assert.equal(await copiesAt(clock, storageFolder).schemaTextOf(url), 'kept');
    assert.equal(stoppingServer.requests.length, 1);
    await stoppingServer.stop();
    clock.time = 2 * DAY_MILLISECONDS;
    assert.equal(await copiesAt(clock, storageFolder).schemaTextOf(url), 'kept');
    assert.equal(await copiesAt(clock).schemaTextOf(url), null);
  } finally {
    await stoppingServer.stop().catch(() => {});
  }
});

test('a URL read is logged by what it did, except a check the server answers unchanged', async () => {
  const clock = { time: 0 };
  const logLines = [];
  const copies = copiesAt(clock, null, logLines);
  schemaServer.serve('/logged.json', { text: 'logged', entityTag: '"mock-logged"' });
  const keptUrl = schemaServer.urlOf('/logged.json?yaml_dsl_max_age_days=1');
  await copies.schemaTextOf(keptUrl);
  clock.time = DAY_MILLISECONDS / 2;
  await copies.schemaTextOf(keptUrl);
  clock.time = 2 * DAY_MILLISECONDS;
  await copies.schemaTextOf(keptUrl);
  await copies.schemaTextOf(schemaServer.urlOf('/logged.json'));
  await copies.schemaTextOf(schemaServer.urlOf('/absent.json?yaml_dsl_max_age_days=1'));
  const fetchUrl = schemaServer.urlOf('/logged.json');
  assert.deepEqual(logLines, [
    `schema ${fetchUrl} downloaded`,
    `schema ${fetchUrl} kept copy used, 0.5 days old`,
    `schema ${fetchUrl} downloaded`,
    `schema ${schemaServer.urlOf('/absent.json')} not downloaded, server answered 404`,
  ]);
});

test('a modeline URL is read through its kept copy, and an editor parameter it misspells is a problem', async () => {
  schemaServer.serve('/modeline.json', {
    text: JSON.stringify({ properties: { size: { type: 'integer', description: '[optional] Mock size.' } } }),
    entityTag: '"mock-modeline"',
  });
  const filePath = '/repo/mock-stack/mock.yml';
  const modelineOf = (query) => `# yaml-language-server: $schema=${schemaServer.urlOf(`/modeline.json${query}`)}\n`;
  const ws = createWorkspace({
    readFile: async () => null,
    fetchText: fetchTextOrNull,
    fetchResponse: fetchResponseOrNull,
  });
  await ws.setConfigs([{ text: configText(dslEntry('sample')), dir: '/repo' }]);
  const kept = `${modelineOf('?yaml_dsl_max_age_days=7')}size: 1\n`;
  await ws.sync(`file://${filePath}`, filePath, kept);
  const hover = ws.hover(`file://${filePath}`, { line: 1, character: 1 });
  assert.equal(hover.contents.value, '`size`: *integer*    `[optional]`\n\nMock size.');
  const misspelled = `${modelineOf('?yaml_dsl_max_age=7')}size: 1\n`;
  await ws.sync(`file://${filePath}`, filePath, misspelled);
  const problems = ws.problems(`file://${filePath}`).map((problem) => [problem.range.start.line, problem.message]);
  assert.deepEqual(problems, [[0, '`yaml_dsl_max_age` is not a parameter the editor reads']]);
});

test('a URL with no max age is fetched on every read, without the editor\'s parameters', async () => {
  const copies = copiesAt({ time: 0 });
  schemaServer.serve('/fresh.json', { text: 'fresh', entityTag: '"mock-fresh"' });
  const url = schemaServer.urlOf('/fresh.json?yaml_dsl_max_age_days=0&a=1');
  assert.equal(await copies.schemaTextOf(url), 'fresh');
  assert.equal(await copies.schemaTextOf(url), 'fresh');
  assert.deepEqual(schemaServer.requests.map((request) => request.path), ['/fresh.json?a=1', '/fresh.json?a=1']);
});

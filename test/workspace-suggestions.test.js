const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const {
  scope,
  declaration,
  reference,
  placeholder,
  dslEntry,
  configText,
} = require('./config-builders');

const OVERLAYS = ['dev', 'staging', 'production'];

const config = configText(dslEntry('resource', {
  file_includes: ['**/mock.yml'],
  layers: {
    overlay_folders: OVERLAYS,
    common_layer_discovery: 'ancestor',
    duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
  },
  key_sort_orders: [
    { path: '$', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
    { path: '$..*', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
  ],
  placeholder: placeholder(),
  locals: { scope_name: 'local' },
  scopes: { local: scope() },
  declarations: [declaration('$.locals.*', 'local', { key_token: 'first_word' })],
  references: [reference('^local\\.(?<name>[a-z0-9_]+)$', 'local')],
}), dslEntry('flat', { file_includes: ['**/flat.yml'] }));

function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      pending.delete(timer);
    },
    fireAll() {
      const due = [...pending];
      pending.clear();
      for (const timer of due) timer.callback();
    },
  };
}

function stackFiles(root) {
  return {
    [`${root}/mock.yml`]: 'locals:\n  team: mock\n',
    [`${root}/dev/mock.yml`]: 'queue:\n  events:\n    size: 1\n    kept: x\n',
    [`${root}/staging/mock.yml`]: 'queue:\n  events:\n    size: 1\n    kept: x\n',
    [`${root}/production/mock.yml`]: 'queue:\n  events:\n    size: 2\n    kept: x\n',
  };
}

function workspaceOver(files, timerFunctions) {
  return createWorkspace({
    readFile: async (filePath) => (Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
    timerFunctions,
  });
}

function nextSuggestions(ws) {
  return new Promise((resolve) => { ws.onSuggestions(resolve); });
}

test('suggestions wait for a quiet stack, then mark the block and move it in one edit', async () => {
  const root = '/repo/mock-stack';
  const files = stackFiles(root);
  const timers = fakeTimers();
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const dev = `${root}/dev/mock.yml`;
  await ws.sync(`file://${dev}`, dev, files[dev]);
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending][0].delay, 500);
  await ws.sync(`file://${dev}`, dev, `${files[dev]}\n`);
  assert.equal(timers.pending.size, 1);
  const arrived = nextSuggestions(ws);
  timers.fireAll();
  const stackId = await arrived;
  assert.equal(stackId, `${root}/mock.yml`);
  const marks = ws.suggestionMarks(stackId);
  const devMarks = marks.files.find((file) => file.uri === `file://${dev}`).marks;
  assert.deepEqual(devMarks.map((mark) => mark.range.start), [{ line: 0, character: 6 }]);
  assert.deepEqual(devMarks[0].suggestion.differences[0].values, [
    { text: '1', overlays: ['dev', 'staging'] },
    { text: '2', overlays: ['production'] },
  ]);
  assert.equal(marks.files.find((file) => file.uri === `file://${root}/mock.yml`).marks.length, 0);
  const moved = ws.applySuggestion(stackId, devMarks[0].suggestion.id);
  assert.deepEqual(Object.keys(moved.edit.changes).sort(), [
    `file://${root}/dev/mock.yml`,
    `file://${root}/mock.yml`,
    `file://${root}/production/mock.yml`,
    `file://${root}/staging/mock.yml`,
  ]);
  assert.deepEqual(moved.edit.changes[`file://${root}/production/mock.yml`], [{
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
    newText: 'locals:\n  queue_events_size: 2\n',
  }]);
  assert.equal(ws.applySuggestion(stackId, '["move",["dev"],["other"]]').problem, 'the suggestion no longer applies');
  assert.equal(ws.applySuggestion('/nowhere', devMarks[0].suggestion.id).problem, 'the stack is no longer loaded');
  assert.deepEqual(ws.suggestionMarks('/nowhere'), { stackId: '/nowhere', files: [] });
});

test('a move the overlays\' schemas disagree on is a potential move, offered again once a schema changes on disk', async () => {
  const root = '/repo/mock-stack';
  const modeline = '# yaml-language-server: $schema=.schema/mock.schema.json\n';
  const queueSchema = JSON.stringify({ type: 'object', properties: { queue: { type: 'object' } } });
  const files = {
    [`${root}/mock.yml`]: '# yaml-language-server: $schema=dev/.schema/mock.schema.json\n',
    [`${root}/dev/mock.yml`]: `${modeline}queue:\n  events: 1\n`,
    [`${root}/staging/mock.yml`]: `${modeline}queue:\n  events: 1\n`,
    [`${root}/production/mock.yml`]: `${modeline}other: 1\n`,
    [`${root}/dev/.schema/mock.schema.json`]: queueSchema,
    [`${root}/staging/.schema/mock.schema.json`]: queueSchema,
    [`${root}/production/.schema/mock.schema.json`]: JSON.stringify({ type: 'object', additionalProperties: false }),
  };
  const timers = fakeTimers();
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const dev = `${root}/dev/mock.yml`;
  const stackId = `${root}/mock.yml`;
  await ws.sync(`file://${dev}`, dev, files[dev]);
  let arrived = nextSuggestions(ws);
  timers.fireAll();
  await arrived;
  const [mark] = ws.suggestionMarks(stackId).files.find((file) => file.uri === `file://${dev}`).marks;
  assert.equal(mark.suggestion.kind, 'potential_move');
  assert.deepEqual(mark.suggestion.schemaGroups, [
    { overlays: ['dev', 'staging'], state: 'constrained' },
    { overlays: ['production'], state: 'not_allowed' },
  ]);
  assert.equal(ws.applySuggestion(stackId, mark.suggestion.id).problem, 'a potential move has no edit to apply');
  files[`${root}/production/.schema/mock.schema.json`] = queueSchema;
  arrived = nextSuggestions(ws);
  await ws.schemasChanged([`${root}/production/.schema/mock.schema.json`]);
  timers.fireAll();
  await arrived;
  const [moveMark] = ws.suggestionMarks(stackId).files.find((file) => file.uri === `file://${dev}`).marks;
  assert.equal(moveMark.suggestion.kind, 'move');
  assert.ok(ws.applySuggestion(stackId, moveMark.suggestion.id).edit);
});

test('one suggestion job waits per stack, a flat stack arms nothing, and an evicted stack is dropped', async () => {
  const timers = fakeTimers();
  const files = { '/repo/one/flat.yml': 'a: 1\n' };
  const roots = Array.from({ length: 10 }, (_, index) => `/repo/stack${index}`);
  for (const root of roots) Object.assign(files, stackFiles(root));
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  ws.setCacheCapacities({ stackCapacity: 8, schemaCapacity: 32 });
  await ws.sync('file:///repo/one/flat.yml', '/repo/one/flat.yml', files['/repo/one/flat.yml']);
  assert.equal(timers.pending.size, 0);
  const firstRoot = roots[0];
  await ws.sync(`file://${firstRoot}/dev/mock.yml`, `${firstRoot}/dev/mock.yml`, files[`${firstRoot}/dev/mock.yml`]);
  const waiting = ws.queueSuggestions(`${firstRoot}/mock.yml`);
  assert.equal(ws.queueSuggestions(`${firstRoot}/mock.yml`), null);
  await waiting;
  ws.close(`file://${firstRoot}/dev/mock.yml`);
  for (const root of roots.slice(1)) {
    await ws.sync(`file://${root}/dev/mock.yml`, `${root}/dev/mock.yml`, files[`${root}/dev/mock.yml`]);
    ws.close(`file://${root}/dev/mock.yml`);
  }
  const evicted = ws.takeEvicted();
  assert.ok(evicted.includes(`${firstRoot}/mock.yml`));
  assert.deepEqual(ws.suggestionMarks(`${firstRoot}/mock.yml`).files, []);
  await ws.queueSuggestions(`${firstRoot}/mock.yml`);
  assert.deepEqual(ws.suggestionMarks(`${firstRoot}/mock.yml`).files, []);
});

test('a stack whose node id table outgrows its files renumbers them', async () => {
  const root = '/repo/mock-stack';
  const files = stackFiles(root);
  const ws = workspaceOver(files, fakeTimers());
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const dev = `${root}/dev/mock.yml`;
  const tables = new Set();
  for (let edit = 0; edit < 40; edit += 1) {
    await ws.sync(`file://${dev}`, dev, `queue:\n  events:\n    size: ${edit}\n    kept: x${edit}\n`);
    tables.add(ws.cache.get(`${root}/mock.yml`).data.nodeIds);
  }
  assert.ok(tables.size > 1);
  const { data } = ws.cache.get(`${root}/mock.yml`);
  const liveNodes = [...data.files.values()].reduce((count, doc) => count + doc.nodeCount, 0);
  assert.ok(data.nodeIds.size() <= 4 * liveNodes + 8);
});

test('a layer file that changes on disk is read again, and a closed one that is deleted leaves the stack', async () => {
  const root = '/repo/mock-stack';
  const files = stackFiles(root);
  const timers = fakeTimers();
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const dev = `${root}/dev/mock.yml`;
  const staging = `${root}/staging/mock.yml`;
  const production = `${root}/production/mock.yml`;
  await ws.sync(`file://${dev}`, dev, files[dev]);
  assert.deepEqual(ws.layerWatchTargets().map((target) => `${target.base}/${target.pattern}`).sort(), [
    `${root}/dev/mock.yml`,
    `${root}/mock.yml`,
    `${root}/production/mock.yml`,
    `${root}/staging/mock.yml`,
  ]);
  files[staging] = 'other: 1\n';
  delete files[production];
  timers.pending.clear();
  await ws.layersChanged([staging, production, dev, '/elsewhere/mock.yml']);
  const { data } = ws.cache.get(`${root}/mock.yml`);
  assert.equal(data.files.get(staging).text, 'other: 1\n');
  assert.equal(data.files.has(production), false);
  assert.equal(data.schemas.has(production), false);
  assert.equal(timers.pending.size, 1);
});

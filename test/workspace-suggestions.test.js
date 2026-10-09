const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { textHashOf } = require('../lib/text-hash');
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

test('a stack evicted and built again without an edit works its suggestions out again', async () => {
  const timers = fakeTimers();
  const files = { ...stackFiles('/repo/first'), ...stackFiles('/repo/second'), ...stackFiles('/repo/third') };
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  ws.setCacheCapacities({ stackCapacity: 1, schemaCapacity: 32 });
  const firstDev = '/repo/first/dev/mock.yml';
  const secondDev = '/repo/second/dev/mock.yml';
  const marksOf = (stackId) => ws.suggestionMarks(stackId).files.flatMap((file) => file.marks);
  const arrivals = [];
  ws.onSuggestions((stackId) => arrivals.push(stackId));
  const settle = async () => {
    timers.fireAll();
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  await ws.setActive(firstDev);
  await settle();
  assert.ok(marksOf('/repo/first/mock.yml').length > 0);
  await ws.setActive(secondDev);
  await ws.setActive('/repo/third/dev/mock.yml');
  await settle();
  assert.ok(ws.takeEvicted().includes('/repo/first/mock.yml'));
  assert.deepEqual(marksOf('/repo/first/mock.yml'), []);
  arrivals.length = 0;
  await ws.setActive(firstDev);
  await settle();
  assert.ok(arrivals.includes('/repo/first/mock.yml'));
  assert.ok(marksOf('/repo/first/mock.yml').length > 0);
  ws.takeEvicted();
  arrivals.length = 0;
  ws.setCacheCapacities({ stackCapacity: 3, schemaCapacity: 32 });
  await ws.setActive(secondDev);
  await settle();
  assert.ok(arrivals.includes('/repo/second/mock.yml'));
});

test('a refresh works out a stack no editor holds without loading it, each file\'s marks carrying its text hash', async () => {
  const timers = fakeTimers();
  const files = stackFiles('/repo/mock-stack');
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const reports = [];
  ws.onSuggestions((stackId) => reports.push(ws.suggestionMarks(stackId)));
  await ws.refreshSuggestions(['/repo/mock-stack/dev/mock.yml', '/repo/mock-stack/staging/mock.yml', '/repo/none.txt']);
  assert.equal(ws.cache.get('/repo/mock-stack/mock.yml'), null);
  assert.equal(reports.length, 1);
  const dev = reports[0].files.find((file) => file.uri === 'file:///repo/mock-stack/dev/mock.yml');
  assert.equal(dev.textHash, textHashOf(files['/repo/mock-stack/dev/mock.yml']));
  assert.equal(dev.marks.length, 1);
  assert.deepEqual(ws.suggestionMarks('/repo/mock-stack/mock.yml'), { stackId: '/repo/mock-stack/mock.yml', files: [] });
  await ws.setActive('/repo/mock-stack/dev/mock.yml');
  timers.pending.clear();
  await ws.refreshSuggestions(['/repo/mock-stack/dev/mock.yml']);
  assert.equal(timers.pending.size, 1);
});

test('a suggestion job that throws is logged and clears that stack\'s suggestions, and the server keeps going', async () => {
  const root = '/repo/mock-stack';
  const files = stackFiles(root);
  const timers = fakeTimers();
  const logged = [];
  let failing = true;
  const { commonLayerSuggestions } = require('../lib/common-layer-suggestions');
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
    timerFunctions: timers,
    logError: (message) => logged.push(message),
    suggestionsOfStack: (stack, schemaChecks) => {
      if (failing) throw new Error('mock suggestion failure');
      return commonLayerSuggestions(stack, schemaChecks);
    },
  });
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const dev = `${root}/dev/mock.yml`;
  await ws.sync(`file://${dev}`, dev, files[dev]);
  let arrived = nextSuggestions(ws);
  timers.fireAll();
  const stackId = await arrived;
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^suggestions for \/repo\/mock-stack\/mock\.yml could not be worked out: Error: mock suggestion failure/);
  assert.deepEqual(ws.suggestionMarks(stackId).files.flatMap((file) => file.marks), []);
  failing = false;
  await ws.sync(`file://${dev}`, dev, `${files[dev]}\n`);
  arrived = nextSuggestions(ws);
  timers.fireAll();
  await arrived;
  assert.equal(ws.suggestionMarks(stackId).files.flatMap((file) => file.marks).length > 0, true);
});

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
  const moved = await ws.applySuggestion(stackId, devMarks[0].suggestion.id);
  const editedUris = moved.edit.documentChanges.map((change) => change.textDocument.uri);
  assert.deepEqual([...editedUris].sort(), [
    `file://${root}/dev/mock.yml`,
    `file://${root}/mock.yml`,
    `file://${root}/production/mock.yml`,
    `file://${root}/staging/mock.yml`,
  ]);
  const productionChange = moved.edit.documentChanges
    .find((change) => change.textDocument.uri === `file://${root}/production/mock.yml`);
  assert.deepEqual(productionChange, {
    textDocument: { uri: `file://${root}/production/mock.yml`, version: null },
    edits: [{
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
      newText: 'locals:\n  queue_events_size: 2\n',
    }],
  });
  assert.deepEqual(moved.files.map((file) => file.uri), editedUris);
  const production = `${root}/production/mock.yml`;
  const productionFile = moved.files.find((file) => file.uri === `file://${production}`);
  assert.equal(productionFile.textHashBefore, textHashOf(files[production]));
  assert.notEqual(productionFile.textHashAfter, productionFile.textHashBefore);
  const devFile = moved.files.find((file) => file.uri === `file://${dev}`);
  assert.equal(devFile.textHashBefore, textHashOf(`${files[dev]}\n`));
  const stale = await ws.applySuggestion(stackId, '["move",["dev"],["other"]]');
  assert.equal(stale.problem, 'the suggestion no longer applies');
  const nowhere = await ws.applySuggestion('/nowhere', devMarks[0].suggestion.id);
  assert.equal(nowhere.problem, 'the stack is no longer in the workspace');
  ws.cache.drop(stackId);
  const reloaded = await ws.applySuggestion(stackId, devMarks[0].suggestion.id);
  assert.ok(reloaded.edit);
  assert.ok(ws.cache.get(stackId));
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
  assert.equal((await ws.applySuggestion(stackId, mark.suggestion.id)).problem, 'a potential move has no edit to apply');
  files[`${root}/production/.schema/mock.schema.json`] = queueSchema;
  arrived = nextSuggestions(ws);
  await ws.schemasChanged([`${root}/production/.schema/mock.schema.json`]);
  timers.fireAll();
  await arrived;
  const [moveMark] = ws.suggestionMarks(stackId).files.find((file) => file.uri === `file://${dev}`).marks;
  assert.equal(moveMark.suggestion.kind, 'move');
  assert.ok((await ws.applySuggestion(stackId, moveMark.suggestion.id)).edit);
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

test('a file opened while a background refresh runs is analyzed at once, before that refresh finishes', async () => {
  const timers = fakeTimers();
  const roots = Array.from({ length: 4 }, (_, index) => `/repo/background-${index}`);
  const files = Object.assign({}, ...roots.map(stackFiles), stackFiles('/repo/opened'));
  const openedDev = '/repo/opened/dev/mock.yml';
  const reads = [];
  let releaseRunningRefresh = null;
  const runningRefreshHeld = new Promise((resolve) => { releaseRunningRefresh = resolve; });
  let opened = null;
  let ws = null;
  ws = createWorkspace({
    readFile: async (filePath) => {
      reads.push(filePath);
      if (filePath === `${roots[0]}/mock.yml`) {
        ws.sync(`file://${openedDev}`, openedDev, files[openedDev]);
        ws.setActive(openedDev);
        opened = ws.whenAnalyzed(`file://${openedDev}`).then(() => 'analyzed');
      }
      if (filePath === `${roots[0]}/production/mock.yml`) await runningRefreshHeld;
      return Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null;
    },
    fetchText: async () => null,
    timerFunctions: timers,
  });
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const refreshing = ws.refreshSuggestions(roots.map((root) => `${root}/dev/mock.yml`));
  let blocked = null;
  const stillBlocked = new Promise((resolve) => { blocked = resolve; });
  const blockedTimer = setTimeout(() => blocked('blocked behind the running refresh'), 200);
  while (!opened) await new Promise((resolve) => { setImmediate(resolve); });
  const outcome = await Promise.race([opened, stillBlocked]);
  clearTimeout(blockedTimer);
  assert.equal(outcome, 'analyzed');
  assert.equal(reads.includes(`${roots[1]}/mock.yml`), false);
  releaseRunningRefresh();
  await refreshing;
});

test('with nothing changing the server does nothing: an unchanged reopen schedules no work and sets no timer', async () => {
  const timers = fakeTimers();
  const root = '/repo/idle-stack';
  const files = stackFiles(root);
  const dev = `${root}/dev/mock.yml`;
  const reads = [];
  const ws = createWorkspace({
    readFile: async (filePath) => {
      reads.push(filePath);
      return Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null;
    },
    fetchText: async () => null,
    timerFunctions: timers,
  });
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${dev}`, dev, files[dev]);
  const arrived = nextSuggestions(ws);
  timers.fireAll();
  await arrived;
  assert.equal(timers.pending.size, 0);
  const readsBefore = reads.length;
  ws.close(`file://${dev}`);
  await ws.sync(`file://${dev}`, dev, files[dev]);
  await ws.setActive(dev);
  assert.equal(timers.pending.size, 0);
  assert.equal(reads.length, readsBefore);
});

test('a stack without a common layer file is offered moves, and applying one creates the file first', async () => {
  const timers = fakeTimers();
  const root = '/repo/no-common-stack';
  const files = stackFiles(root);
  delete files[`${root}/mock.yml`];
  const dev = `${root}/dev/mock.yml`;
  const ws = workspaceOver(files, timers);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${dev}`, dev, files[dev]);
  const arrived = nextSuggestions(ws);
  timers.fireAll();
  const stackId = await arrived;
  const devMarks = ws.suggestionMarks(stackId).files.find((file) => file.uri === `file://${dev}`).marks;
  assert.equal(devMarks[0].suggestion.createsCommonLayer, true);
  const moved = await ws.applySuggestion(stackId, devMarks[0].suggestion.id);
  const commonUri = `file://${root}/mock.yml`;
  const creation = moved.edit.documentChanges.findIndex((change) => change.kind === 'create');
  const commonEdit = moved.edit.documentChanges
    .findIndex((change) => change.textDocument && change.textDocument.uri === commonUri);
  assert.deepEqual(moved.edit.documentChanges[creation], {
    kind: 'create',
    uri: commonUri,
    options: { ignoreIfExists: true },
  });
  assert.ok(creation < commonEdit);
  assert.match(moved.edit.documentChanges[commonEdit].edits[0].newText, /^locals:\n {2}queue_events_size: 1\n/);
});

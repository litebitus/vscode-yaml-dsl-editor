const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { createWorkTracker } = require('../lib/work-tracker');
const { commonLayerSuggestions } = require('../lib/common-layer-suggestions');
const { dslEntry, configText } = require('./config-builders');

const SHARED_TEXT = 'mocktype:\n  shared:\n    size: 1\n';
const EDITED_TEXT = 'mocktype:\n  shared:\n    size: 1\n    label: mock-label\n';
const layeredConfig = configText(dslEntry('mock-dsl', {
  file_includes: ['**/mock-dsl.yml'],
  layers: {
    overlay_folders: ['overlay-1', 'overlay-2'],
    common_layer_discovery: 'parent',
    duplicate_check: { depth: 2, key_depths: {}, skip_keys: [] },
  },
  key_sort_orders: [
    { path: '$', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
    { path: '$..*', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
  ],
}));

function stackFilesOf(root) {
  return {
    [`${root}/mock-dsl.yml`]: 'other: mock-other\n',
    [`${root}/overlay-1/mock-dsl.yml`]: SHARED_TEXT,
    [`${root}/overlay-2/mock-dsl.yml`]: SHARED_TEXT,
  };
}

function fakeTimerFunctions() {
  const pending = new Set();
  const delays = [];
  return {
    pending,
    delays,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      pending.add(timer);
      delays.push(delay);
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

function settledTurns() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

let session = null;

function sessionOf({ failingPass = false } = {}) {
  const files = {
    ...stackFilesOf('/repo/concern-1'),
    ...stackFilesOf('/repo/concern-2'),
    ...stackFilesOf('/repo/concern-3'),
  };
  const quietTimers = fakeTimerFunctions();
  const boundTimers = fakeTimerFunctions();
  const tracker = createWorkTracker({ timerFunctions: boundTimers, logFailure: () => {} });
  const events = [];
  const loggedErrors = [];
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
    timerFunctions: quietTimers,
    trackWork: tracker.track,
    logError: (message) => loggedErrors.push(message),
    suggestionsOfStack: (stack, schemaChecks) => {
      events.push(`pass ${stack.common}`);
      if (failingPass) throw new Error('mock failing pass');
      return commonLayerSuggestions(stack, schemaChecks);
    },
  });
  ws.onSuggestions((stackId) => {
    const marks = ws.suggestionMarks(stackId).files.flatMap((file) => file.marks);
    events.push(`report ${stackId} ${marks.map((mark) => mark.suggestion.kind).join(',')}`);
  });
  return { files, quietTimers, boundTimers, tracker, events, loggedErrors, ws };
}

async function openedOverlay(root, text = SHARED_TEXT) {
  const overlayPath = `${root}/overlay-1/mock-dsl.yml`;
  await session.ws.sync(`file://${overlayPath}`, overlayPath, text);
}

async function passesRun() {
  session.quietTimers.fireAll();
  for (let turn = 0; turn < 10; turn += 1) await settledTurns();
}

test.beforeEach(async () => {
  session = sessionOf();
  await session.ws.setConfigs([{ text: layeredConfig, dir: '/repo' }]);
});

test.afterEach(() => {
  session.ws.dispose();
  session = null;
});

test('idle waits for a pass armed while it waits on other work, and answers once that pass is done',
async () => {
  let finishHeldJob = null;
  session.tracker.track(new Promise((resolve) => { finishHeldJob = resolve; }));
  const idle = session.tracker.whenIdle().then(() => session.events.push('idle'));
  await openedOverlay('/repo/concern-1');
  finishHeldJob();
  for (let turn = 0; turn < 10; turn += 1) await settledTurns();
  assert.deepEqual(session.events, []);
  await passesRun();
  await idle;
  assert.deepEqual(session.events, [
    'pass /repo/concern-1/mock-dsl.yml',
    'report /repo/concern-1/mock-dsl.yml move,move',
    'idle',
  ]);
});

test('a pass re-armed by a later edit is the one idle waits for, and the superseded one never runs',
async () => {
  await openedOverlay('/repo/concern-1');
  await openedOverlay('/repo/concern-1', EDITED_TEXT);
  assert.equal(session.quietTimers.pending.size, 1);
  const idle = session.tracker.whenIdle().then(() => session.events.push('idle'));
  await settledTurns();
  assert.deepEqual(session.events, []);
  await passesRun();
  await idle;
  assert.deepEqual(session.events.filter((event) => event.startsWith('pass')), [
    'pass /repo/concern-1/mock-dsl.yml',
  ]);
  assert.equal(session.events.at(-1), 'idle');
});

test('a pass that fails is logged and still lets idle answer', async () => {
  session.ws.dispose();
  session = sessionOf({ failingPass: true });
  await session.ws.setConfigs([{ text: layeredConfig, dir: '/repo' }]);
  await openedOverlay('/repo/concern-1');
  const idle = session.tracker.whenIdle();
  await passesRun();
  await idle;
  assert.equal(session.loggedErrors.length, 1);
  const failedPass = /suggestions for \/repo\/concern-1\/mock-dsl\.yml could not be worked out/;
  assert.match(session.loggedErrors[0], failedPass);
});

test('idle rejects at its bound while a pass is still armed', async () => {
  await openedOverlay('/repo/concern-1');
  const idle = session.tracker.whenIdle();
  const [boundTimer] = session.boundTimers.pending;
  boundTimer.callback();
  await assert.rejects(idle, /tracked work did not finish within/);
});

test('an armed pass of an evicted stack lets idle answer', async () => {
  session.ws.setCacheCapacities({ stackCapacity: 1, schemaCapacity: 32 });
  for (const root of ['/repo/concern-1', '/repo/concern-2']) {
    await openedOverlay(root);
    await session.ws.close(`file://${root}/overlay-1/mock-dsl.yml`);
  }
  await openedOverlay('/repo/concern-3');
  assert.deepEqual(session.ws.takeEvicted(), ['/repo/concern-1/mock-dsl.yml']);
  const idle = session.tracker.whenIdle();
  await passesRun();
  await idle;
  assert.deepEqual(session.events.filter((event) => event.startsWith('pass')), [
    'pass /repo/concern-3/mock-dsl.yml',
    'pass /repo/concern-2/mock-dsl.yml',
  ]);
});

async function editingScenario(withIdleRequest) {
  await openedOverlay('/repo/concern-1');
  await openedOverlay('/repo/concern-2');
  await openedOverlay('/repo/concern-1', EDITED_TEXT);
  const idle = withIdleRequest ? session.tracker.whenIdle() : null;
  await passesRun();
  await openedOverlay('/repo/concern-2', EDITED_TEXT);
  await passesRun();
  if (idle) await idle;
  return {
    events: session.events,
    quietDelays: session.quietTimers.delays,
    marks: ['/repo/concern-1/mock-dsl.yml', '/repo/concern-2/mock-dsl.yml']
      .map((stackId) => session.ws.suggestionMarks(stackId)),
  };
}

test('an idle request in flight leaves the quiet period, the superseding, '
  + 'the passes and their order, and the marks unchanged', async () => {
  const withoutIdle = await editingScenario(false);
  session.ws.dispose();
  session = sessionOf();
  await session.ws.setConfigs([{ text: layeredConfig, dir: '/repo' }]);
  const withIdle = await editingScenario(true);
  assert.deepEqual(withIdle, withoutIdle);
  assert.ok(withoutIdle.quietDelays.every((delay) => delay === 500));
  assert.equal(withoutIdle.events.filter((event) => event.startsWith('pass')).length, 3);
});

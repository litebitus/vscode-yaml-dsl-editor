const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkTracker, IDLE_WAIT_MILLISECONDS } = require('../lib/work-tracker');

function deferredJob() {
  let finish = null;
  const job = new Promise((resolve) => { finish = resolve; });
  return { job, finish };
}

test('idle waits for every tracked job, including one tracked while it waits', async () => {
  const tracker = createWorkTracker();
  const first = deferredJob();
  const second = deferredJob();
  const finishedJobs = [];
  tracker.track(first.job.then(() => finishedJobs.push('first')));
  const idle = tracker.whenIdle().then(() => finishedJobs.push('idle'));
  tracker.track(second.job.then(() => finishedJobs.push('second')));
  first.finish();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(finishedJobs, ['first']);
  second.finish();
  await idle;
  assert.deepEqual(finishedJobs, ['first', 'second', 'idle']);
});

test('a tracked job that fails is logged and still lets idle answer', async () => {
  const loggedFailures = [];
  const tracker = createWorkTracker({ logFailure: (error) => loggedFailures.push(error.message) });
  tracker.track(Promise.reject(new Error('mock failure')));
  await tracker.whenIdle();
  assert.deepEqual(loggedFailures, ['mock failure']);
});

test('idle rejects once tracked work outlasts its bound, and clears the bound when it answers',
async () => {
  const pendingTimers = new Set();
  const timerFunctions = {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      pendingTimers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => pendingTimers.delete(timer),
  };
  const tracker = createWorkTracker({ timerFunctions });
  await tracker.whenIdle();
  assert.equal(pendingTimers.size, 0);
  tracker.track(new Promise(() => {}));
  const idle = tracker.whenIdle();
  const [boundTimer] = pendingTimers;
  assert.equal(boundTimer.delay, IDLE_WAIT_MILLISECONDS);
  boundTimer.callback();
  await assert.rejects(idle, /tracked work did not finish within 10000 ms/);
});

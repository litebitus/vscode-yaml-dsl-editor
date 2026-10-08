const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkQueue } = require('../lib/work-queue');

const ACTIVE_ONLY = { interactivePriorityLimit: 0 };

test('work runs one job at a time, by priority and then in the order it came', async () => {
  const queue = createWorkQueue(ACTIVE_ONLY);
  const ran = [];
  const record = (name) => async () => { ran.push(name); return name; };
  const jobs = [
    queue.schedule(2, 'warm-a', record('warm-a')),
    queue.schedule(2, 'warm-b', record('warm-b')),
    queue.schedule(1, 'open', record('open')),
    queue.schedule(0, 'active', record('active')),
  ];
  assert.deepEqual(await Promise.all(jobs), ['warm-a', 'warm-b', 'open', 'active']);
  assert.deepEqual(ran, ['active', 'open', 'warm-a', 'warm-b']);
});

test('promoted work moves ahead, and work that arrives mid-run goes ahead of waiting background', async () => {
  const queue = createWorkQueue(ACTIVE_ONLY);
  const ran = [];
  let arrive;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  queue.schedule(2, 'warm-a', async () => { ran.push('warm-a'); arrive(); });
  queue.schedule(2, 'warm-b', async () => { ran.push('warm-b'); });
  queue.schedule(2, 'later', async () => { ran.push('later'); });
  queue.promote('later', 1);
  queue.promote('warm-b', 3);
  await arrived;
  const active = queue.schedule(0, 'active', async () => { ran.push('active'); });
  assert.equal(queue.hasWork('active'), true);
  await active;
  await queue.settledFor('warm-b');
  assert.deepEqual(ran, ['later', 'warm-a', 'active', 'warm-b']);
  assert.equal(queue.hasWork('warm-b'), false);
});

test('active work starts while background work waits on I/O, and the background resumes only after it', async () => {
  const queue = createWorkQueue(ACTIVE_ONLY);
  const ran = [];
  let finishRead;
  const backgroundRead = new Promise((resolve) => { finishRead = resolve; });
  const background = queue.schedule(2, 'warm', async () => {
    ran.push('warm starts');
    await backgroundRead;
    ran.push('warm ends');
  });
  queue.schedule(2, 'warm-next', async () => { ran.push('warm-next'); });
  while (ran.length === 0) await new Promise((resolve) => { setImmediate(resolve); });
  await queue.schedule(0, 'active', async () => { ran.push('active'); });
  assert.deepEqual(ran, ['warm starts', 'active']);
  finishRead();
  await background;
  await queue.settledFor('warm-next');
  assert.deepEqual(ran, ['warm starts', 'active', 'warm ends', 'warm-next']);
});

test('active work for the stack a background job holds waits for that job, and goes next', async () => {
  const queue = createWorkQueue(ACTIVE_ONLY);
  const ran = [];
  let finishRead;
  const backgroundRead = new Promise((resolve) => { finishRead = resolve; });
  queue.schedule(2, 'mock-stack', async () => {
    ran.push('background starts');
    await backgroundRead;
    ran.push('background ends');
  });
  queue.schedule(2, 'other', async () => { ran.push('other'); });
  while (ran.length === 0) await new Promise((resolve) => { setImmediate(resolve); });
  const active = queue.schedule(0, 'mock-stack', async () => { ran.push('active'); });
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(ran, ['background starts']);
  finishRead();
  await active;
  await queue.settledFor('other');
  assert.deepEqual(ran, ['background starts', 'background ends', 'active', 'other']);
});

test('a failing job rejects its caller and leaves the rest running, and settling waits for running work', async () => {
  const queue = createWorkQueue(ACTIVE_ONLY);
  let finish;
  const running = queue.schedule(1, 'slow', () => new Promise((resolve) => { finish = resolve; }));
  const failing = queue.schedule(1, 'broken', async () => { throw new Error('mock failure'); });
  while (!finish) await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(queue.hasWork('slow'), true);
  const settled = queue.settledFor('slow');
  finish('done');
  assert.deepEqual(await settled, [{ status: 'fulfilled', value: 'done' }]);
  assert.equal(await running, 'done');
  await assert.rejects(failing, /mock failure/);
  assert.deepEqual(await queue.settledFor('nothing'), []);
});

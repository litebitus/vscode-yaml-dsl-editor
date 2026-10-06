const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkQueue } = require('../lib/work-queue');

test('work runs one job at a time, by priority and then in the order it came', async () => {
  const queue = createWorkQueue();
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
  const queue = createWorkQueue();
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

test('a failing job rejects its caller and leaves the rest running, and settling waits for running work', async () => {
  const queue = createWorkQueue();
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

const test = require('node:test');
const assert = require('node:assert/strict');
const { clockTimeOf, createActivityLog } = require('../lib/activity-log');

function recordingChannel() {
  const lines = [];
  return { lines, appendLine: (line) => lines.push(line) };
}

const mockMoment = new Date(2026, 9, 9, 9, 4, 2, 7);

test('each line carries the local clock time to the millisecond', () => {
  assert.equal(clockTimeOf(mockMoment), '09:04:02.007');
  const channel = recordingChannel();
  createActivityLog(channel, () => mockMoment).info('language server started');
  assert.deepEqual(channel.lines, ['[09:04:02.007] language server started']);
});

test('a failing step is logged with its name and message and yields its fallback, so the next step still runs', async () => {
  const channel = recordingChannel();
  const log = createActivityLog(channel, () => mockMoment);
  const claimed = await log.step('claiming visible files', async () => { throw new Error('mock refused'); }, 0);
  const painted = await log.step('painting saved suggestions', async () => 3, 0);
  assert.deepEqual([claimed, painted], [0, 3]);
  assert.deepEqual(channel.lines, ['[09:04:02.007] error: claiming visible files failed: mock refused']);
  log.failure('background startup', 'mock text failure');
  assert.equal(channel.lines.at(-1), '[09:04:02.007] error: background startup failed: mock text failure');
});

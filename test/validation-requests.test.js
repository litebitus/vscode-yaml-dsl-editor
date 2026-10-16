const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const {
  VALIDATION_DEADLINE_MILLISECONDS,
  createInProcessValidation,
  createWorkerValidation,
} = require('../lib/validation-requests');
const { VALIDATION_FAILED_KEYWORD, createValidationHost } = require('../lib/validation-host');

const MOCK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: { size: { type: 'integer' }, mode: { enum: ['mock-a', 'mock-b'] } },
};
const MOCK_FIXTURE_WORKERS = path.join(__dirname, 'fixtures', 'validation-workers');

function mockRequest(value, fields = {}) {
  return {
    slot: '/mock/mock.yml',
    schemaHash: 'mock-schema-hash',
    schemaRoot: MOCK_SCHEMA,
    compiledSchemaFile: null,
    value,
    fragmentPointer: null,
    ...fields,
  };
}

function fixtureWorker(name) {
  return () => {
    const worker = new Worker(path.join(MOCK_FIXTURE_WORKERS, `${name}.js`));
    worker.unref();
    return worker;
  };
}

function workerSequence(...startWorkers) {
  const started = [];
  return {
    started,
    startWorker: () => {
      const worker = startWorkers[Math.min(started.length, startWorkers.length - 1)]();
      started.push(worker);
      return worker;
    },
  };
}

function realWorker() {
  return new Worker(path.join(__dirname, '..', 'lib', 'validation-worker.js'));
}

const inProcessProblemsOf = (value) => createInProcessValidation().problemsOf(mockRequest(value));
const messagesOf = (problems) => problems.map((problem) => problem.message);

test('in process, a document is validated when asked, its schema added once and again after it is dropped', () => {
  const validation = createInProcessValidation();
  const problems = validation.problemsOf(mockRequest({ size: 'mock', extra: 1 }));
  assert.deepEqual(messagesOf(problems), ['`extra` is not a field of the document', '`size` must be integer']);
  validation.dropSchema('mock-schema-hash');
  assert.deepEqual(messagesOf(validation.problemsOf(mockRequest({ size: 'mock' }))), ['`size` must be integer']);
  validation.onAnswered(() => assert.fail('an in-process validation answers when asked'));
  validation.dropSlot('/mock/mock.yml');
  validation.close();
  return validation.whenSettled();
});

test('in the worker, a document is pending until answered, then answered from the store, '
  + 'the earlier answer kept while a newer one is pending', async () => {
  const validation = createWorkerValidation();
  const answeredSlots = [];
  validation.onAnswered((slot) => answeredSlots.push(slot));
  assert.equal(validation.problemsOf(mockRequest({ size: 'mock' })), null);
  await validation.whenSettled();
  assert.deepEqual(answeredSlots, ['/mock/mock.yml']);
  const answered = validation.problemsOf(mockRequest({ size: 'mock' }));
  assert.deepEqual(answered, inProcessProblemsOf({ size: 'mock' }));
  assert.deepEqual(validation.problemsOf(mockRequest({ mode: 'mock-c' })), answered);
  assert.deepEqual(validation.problemsOf(mockRequest({ mode: 'mock-c' })), answered);
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(mockRequest({ mode: 'mock-c' })), inProcessProblemsOf({ mode: 'mock-c' }));
  assert.deepEqual(answeredSlots, ['/mock/mock.yml', '/mock/mock.yml']);
  validation.close();
});

test('a schema the workspace drops is sent again with its next request, and a dropped slot asks again', async () => {
  const validation = createWorkerValidation();
  validation.problemsOf(mockRequest({ size: 1 }));
  await validation.whenSettled();
  validation.dropSchema('mock-schema-hash');
  validation.dropSchema('mock-never-sent');
  validation.problemsOf(mockRequest({ size: 'mock' }));
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(mockRequest({ size: 'mock' })), inProcessProblemsOf({ size: 'mock' }));
  validation.dropSlot('/mock/mock.yml');
  assert.equal(validation.problemsOf(mockRequest({ size: 'mock' })), null);
  await validation.whenSettled();
  validation.close();
});

test('a worker that exits is started again and the request sent again; '
  + 'one that exits twice is the answer', async () => {
  const restarted = workerSequence(fixtureWorker('exiting-worker'), realWorker);
  const recovering = createWorkerValidation({ startWorker: restarted.startWorker });
  assert.equal(recovering.problemsOf(mockRequest({ size: 'mock' })), null);
  await recovering.whenSettled();
  assert.equal(restarted.started.length, 2);
  assert.deepEqual(recovering.problemsOf(mockRequest({ size: 'mock' })), inProcessProblemsOf({ size: 'mock' }));
  recovering.close();

  const failing = workerSequence(fixtureWorker('exiting-worker'));
  const stopped = createWorkerValidation({ startWorker: failing.startWorker });
  stopped.problemsOf(mockRequest({ size: 'mock' }));
  await stopped.whenSettled();
  assert.equal(failing.started.length, 2);
  assert.deepEqual(stopped.problemsOf(mockRequest({ size: 'mock' })), [{
    path: [],
    message: 'validation stopped: the validation worker exited with code 3',
    keyword: VALIDATION_FAILED_KEYWORD,
  }]);
  stopped.close();
});

test('a request past its deadline is answered with a problem, and the late answer replaces it', async () => {
  const deadlines = [];
  const timerFunctions = {
    setTimeout: (callback, milliseconds) => {
      deadlines.push({ callback, milliseconds, cleared: false });
      return deadlines.length - 1;
    },
    clearTimeout: (index) => {
      if (deadlines[index]) deadlines[index].cleared = true;
    },
  };
  const validation = createWorkerValidation({ startWorker: realWorker, timerFunctions });
  const answeredSlots = [];
  validation.onAnswered((slot) => answeredSlots.push(slot));
  validation.problemsOf(mockRequest({ size: 'mock' }));
  assert.equal(deadlines[0].milliseconds, VALIDATION_DEADLINE_MILLISECONDS);
  deadlines[0].callback();
  assert.deepEqual(messagesOf(validation.problemsOf(mockRequest({ size: 'mock' }))), [
    `validation did not answer within ${VALIDATION_DEADLINE_MILLISECONDS / 1000} seconds`,
  ]);
  await validation.whenSettled();
  assert.equal(deadlines[0].cleared, true);
  assert.deepEqual(validation.problemsOf(mockRequest({ size: 'mock' })), inProcessProblemsOf({ size: 'mock' }));
  assert.deepEqual(answeredSlots, ['/mock/mock.yml', '/mock/mock.yml']);
  validation.close();
});

test('a worker\'s log lines reach the server\'s log, and a message of no known kind is passed over', async () => {
  const logged = [];
  const validation = createWorkerValidation({
    startWorker: fixtureWorker('silent-worker'),
    logError: (message) => logged.push(message),
  });
  validation.problemsOf(mockRequest({ size: 'mock' }));
  const settled = validation.whenSettled();
  while (logged.length === 0) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(logged, ['mock worker started']);
  validation.close();
  await settled;
});

test('an opted-in schema compiled in the worker is saved, '
  + 'and a later worker loads it and answers the same', async () => {
  const storageFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-storage-'));
  const compiledSchemaFile = path.join(storageFolder, 'compiled-schemas', 'mock-dsl.js');
  const answers = [];
  const savedFiles = [];
  for (const run of ['compiles', 'loads']) {
    const validation = createWorkerValidation({ logError: (message) => assert.fail(`${run}: ${message}`) });
    validation.problemsOf(mockRequest({ size: 'mock', extra: 1 }, { compiledSchemaFile }));
    await validation.whenSettled();
    answers.push(validation.problemsOf(mockRequest({ size: 'mock', extra: 1 }, { compiledSchemaFile })));
    validation.close();
    savedFiles.push({ text: fs.readFileSync(compiledSchemaFile, 'utf8'), inode: fs.statSync(compiledSchemaFile).ino });
  }
  const savedHeader = /^\/\/ yaml-dsl-editor compiled schema \{"schemaHash":"mock-schema-hash","buildKey":"/;
  assert.match(savedFiles[0].text, savedHeader);
  assert.deepEqual(savedFiles[1], savedFiles[0]);
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[0], inProcessProblemsOf({ size: 'mock', extra: 1 }));
});

test('a compiled schema the worker cannot save reaches the server\'s log, '
  + 'and the document is still answered', async () => {
  const folderThatIsAFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-storage-')), 'mock');
  fs.writeFileSync(folderThatIsAFile, 'mock');
  const logged = [];
  const validation = createWorkerValidation({ logError: (message) => logged.push(message) });
  const compiledSchemaFile = path.join(folderThatIsAFile, 'mock-dsl.js');
  validation.problemsOf(mockRequest({ size: 'mock' }, { compiledSchemaFile }));
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(mockRequest({ size: 'mock' }, { compiledSchemaFile })), inProcessProblemsOf({
    size: 'mock',
  }));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^the compiled schema could not be saved to .*mock-dsl\.js: /);
  validation.close();
});

test('a schema that breaks validation is answered with the reason', () => {
  const host = createValidationHost();
  const brokenProperties = new Proxy({}, { ownKeys: () => { throw new Error('mock broken schema'); } });
  host.addSchema('mock-broken-hash', { type: 'object', properties: brokenProperties }, null);
  assert.deepEqual(host.problemsOf('mock-broken-hash', {}, null), [{
    path: [],
    message: 'validation failed: mock broken schema',
    keyword: VALIDATION_FAILED_KEYWORD,
  }]);
});

test('a closed validation sends nothing more', async () => {
  const workers = workerSequence(realWorker);
  const validation = createWorkerValidation({ startWorker: workers.startWorker });
  validation.problemsOf(mockRequest({ size: 'mock' }));
  await validation.whenSettled();
  validation.close();
  assert.deepEqual(validation.problemsOf(mockRequest({ size: 'mock' })), inProcessProblemsOf({ size: 'mock' }));
  assert.deepEqual(validation.problemsOf(mockRequest({ size: 1 })), inProcessProblemsOf({ size: 'mock' }));
  assert.equal(validation.problemsOf(mockRequest({ size: 1 }, { slot: '/mock/other.yml' })), null);
  await validation.whenSettled();
  assert.equal(workers.started.length, 1);
  validation.close();
});

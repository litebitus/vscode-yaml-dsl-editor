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
const { resolvedDocumentOf } = require('../lib/resolved-document');
const { quotedValuesValidator } = require('./validation-builders');

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
    schemaStoreFolder: null,
    document: resolvedDocumentOf(value),
    fragmentPointer: null,
    validator: null,
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
  assert.deepEqual(messagesOf(problems), ['`size` must be `integer`', '`extra` is not defined in the schema']);
  validation.dropSchema('mock-schema-hash');
  assert.deepEqual(messagesOf(validation.problemsOf(mockRequest({ size: 'mock' }))), ['`size` must be `integer`']);
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

test('in the worker, a problem\'s schema note arrives beside its message', async () => {
  const validation = createWorkerValidation();
  const notedRequest = mockRequest({ mapping: { color: 'red' } }, {
    schemaHash: 'mock-noted-schema-hash',
    schemaRoot: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { mapping: { not: { description: 'Mock: no `color` here.', required: ['color'] } } },
    },
  });
  validation.problemsOf(notedRequest);
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(notedRequest).map(({ message, schemaNote }) => [message, schemaNote]), [
    ['`mapping` matches a form that is not allowed', 'Mock: no `color` here.'],
  ]);
  validation.close();
});

test('the types a quoted value is read as reach the worker, and other types are another request', async () => {
  const validation = createWorkerValidation();
  const quoted = { size: '12' };
  const integers = { validator: quotedValuesValidator(['integer']) };
  const booleans = { validator: quotedValuesValidator(['boolean']) };
  assert.deepEqual(messagesOf(createInProcessValidation().problemsOf(mockRequest(quoted, integers))), []);
  validation.problemsOf(mockRequest(quoted, integers));
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(mockRequest(quoted, integers)), []);
  assert.deepEqual(validation.problemsOf(mockRequest(quoted, booleans)), []);
  await validation.whenSettled();
  assert.deepEqual(
    messagesOf(validation.problemsOf(mockRequest(quoted, booleans))),
    ['`size` must be `integer`'],
  );
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

test('an opted-in schema prepared in the worker is kept in the schema store, '
  + 'and a later worker reads it and answers the same', async () => {
  const schemaStoreFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-schema-store-'));
  const answers = [];
  const keptEntries = [];
  for (const run of ['prepares', 'reads']) {
    const validation = createWorkerValidation({ logError: (message) => assert.fail(`${run}: ${message}`) });
    validation.problemsOf(mockRequest({ size: 'mock', extra: 1 }, { schemaStoreFolder }));
    await validation.whenSettled();
    answers.push(validation.problemsOf(mockRequest({ size: 'mock', extra: 1 }, { schemaStoreFolder })));
    validation.close();
    keptEntries.push(fs.readdirSync(schemaStoreFolder).map((name) => {
      const entryFile = path.join(schemaStoreFolder, name);
      return { name, text: fs.readFileSync(entryFile, 'utf8'), inode: fs.statSync(entryFile).ino };
    }));
  }
  assert.equal(keptEntries[0].length, 1);
  assert.match(keptEntries[0][0].name, /^[0-9a-f]{64}\.json$/);
  assert.deepEqual(keptEntries[1], keptEntries[0]);
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[0], inProcessProblemsOf({ size: 'mock', extra: 1 }));
});

test('a prepared schema the worker cannot keep reaches the server\'s log, '
  + 'and the document is still answered', async () => {
  const folderThatIsAFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-mock-storage-')), 'mock');
  fs.writeFileSync(folderThatIsAFile, 'mock');
  const logged = [];
  const validation = createWorkerValidation({ logError: (message) => logged.push(message) });
  const schemaStoreFolder = path.join(folderThatIsAFile, 'schema-store');
  validation.problemsOf(mockRequest({ size: 'mock' }, { schemaStoreFolder }));
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(mockRequest({ size: 'mock' }, { schemaStoreFolder })), inProcessProblemsOf({
    size: 'mock',
  }));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^the compiled schema could not be saved to .*[0-9a-f]{64}\.json: /);
  validation.close();
});

test('a schema capacity set before the worker starts and after it runs reaches the worker, '
  + 'and every held schema still answers', async (context) => {
  const validation = createWorkerValidation({ logError: (message) => assert.fail(message) });
  context.after(() => validation.close());
  validation.setSchemaCapacity(1);
  const otherSchema = { ...MOCK_SCHEMA, title: 'mock-other' };
  const otherRequest = (value) => mockRequest(value, {
    slot: '/mock/other.yml',
    schemaHash: 'mock-other-hash',
    schemaRoot: otherSchema,
  });
  validation.problemsOf(mockRequest({ size: 'mock' }));
  validation.problemsOf(otherRequest({ mode: 'mock-c' }));
  await validation.whenSettled();
  validation.setSchemaCapacity(2);
  validation.problemsOf(mockRequest({ size: 'mock', extra: 1 }));
  await validation.whenSettled();
  assert.deepEqual(validation.problemsOf(otherRequest({ mode: 'mock-c' })), inProcessProblemsOf({ mode: 'mock-c' }));
  assert.deepEqual(
    validation.problemsOf(mockRequest({ size: 'mock', extra: 1 })),
    inProcessProblemsOf({ size: 'mock', extra: 1 }),
  );
  validation.close();
  validation.setSchemaCapacity(3);
  assert.deepEqual(validation.problemsOf(otherRequest({ mode: 'mock-c' })), inProcessProblemsOf({ mode: 'mock-c' }));
});

test('a document that breaks validation is answered with the reason', () => {
  const host = createValidationHost();
  host.addSchema('mock-broken-hash', JSON.stringify(MOCK_SCHEMA), null);
  const brokenDocument = { kind: 'map', get value() { throw new Error('mock broken document'); } };
  assert.deepEqual(host.problemsOf('mock-broken-hash', brokenDocument, { fragmentPointer: null }), [{
    path: [],
    message: 'validation failed: mock broken document',
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

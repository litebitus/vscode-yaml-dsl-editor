const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const { VALIDATION_MESSAGE_KINDS, validationFailedProblem, createValidationHost } = require('./validation-host');

const VALIDATION_DEADLINE_MILLISECONDS = 60000;
const VALIDATION_WORKER_FILE = path.join(__dirname, 'validation-worker.js');

function startValidationWorker() {
  const worker = new Worker(VALIDATION_WORKER_FILE);
  worker.unref();
  return worker;
}

function requestKeyOf({ schemaHash, fragmentPointer, value }) {
  return crypto.createHash('sha256')
    .update(`${schemaHash}\n${fragmentPointer}\n${JSON.stringify(value)}`)
    .digest('hex');
}

function createInProcessValidation() {
  const host = createValidationHost();

  function problemsOf({ schemaHash, schemaRoot, value, fragmentPointer }) {
    if (!host.hasSchema(schemaHash)) host.addSchema(schemaHash, schemaRoot, null);
    return host.problemsOf(schemaHash, value, fragmentPointer);
  }

  return {
    problemsOf,
    onAnswered: () => {},
    dropSchema: (schemaHash) => host.dropSchema(schemaHash),
    dropSlot: () => {},
    whenSettled: () => Promise.resolve(),
    close: () => {},
  };
}

function createWorkerValidation({
  startWorker = startValidationWorker,
  timerFunctions = { setTimeout, clearTimeout },
  deadlineMilliseconds = VALIDATION_DEADLINE_MILLISECONDS,
  logError = (message) => console.error(message),
} = {}) {
  const answersBySlot = new Map();
  const requestsBySlot = new Map();
  const slotsByRequestId = new Map();
  const schemasSent = new Set();
  const settledWaiters = [];
  let worker = null;
  let requestCount = 0;
  let answeredListener = () => {};
  let closed = false;

  function notifySettled() {
    if (requestsBySlot.size > 0) return;
    for (const resolve of settledWaiters.splice(0)) resolve();
  }

  function answer(slot, key, problems) {
    answersBySlot.set(slot, { key, problems });
    answeredListener(slot);
  }

  function finish(slot) {
    const request = requestsBySlot.get(slot);
    if (!request) return;
    timerFunctions.clearTimeout(request.deadlineTimer);
    slotsByRequestId.delete(request.requestId);
    requestsBySlot.delete(slot);
    notifySettled();
  }

  function onWorkerMessage(message) {
    if (message.kind === VALIDATION_MESSAGE_KINDS.log) {
      logError(message.message);
      return;
    }
    if (message.kind !== VALIDATION_MESSAGE_KINDS.answer) return;
    const slot = slotsByRequestId.get(message.requestId);
    if (slot === undefined) return;
    const { key } = requestsBySlot.get(slot);
    finish(slot);
    answer(slot, key, message.problems);
  }

  function onWorkerExit(exitedWorker, reason) {
    if (exitedWorker !== worker || closed) return;
    worker = null;
    schemasSent.clear();
    for (const [slot, request] of [...requestsBySlot]) {
      if (request.resent) {
        finish(slot);
        answer(slot, request.key, [validationFailedProblem(`validation stopped: ${reason()}`)]);
      } else {
        request.resent = true;
        send(request);
      }
    }
  }

  function runningWorker() {
    if (worker) return worker;
    const started = startWorker();
    let lastError = null;
    started.on('message', onWorkerMessage);
    started.on('error', (error) => { lastError = error; });
    started.on('exit', (code) => onWorkerExit(started, () => (lastError
      ? lastError.message
      : `the validation worker exited with code ${code}`)));
    worker = started;
    return worker;
  }

  function send(request) {
    const target = runningWorker();
    if (!schemasSent.has(request.schemaHash)) {
      target.postMessage({
        kind: VALIDATION_MESSAGE_KINDS.schema,
        schemaHash: request.schemaHash,
        root: request.schemaRoot,
        compiledSchemaFile: request.compiledSchemaFile,
      });
      schemasSent.add(request.schemaHash);
    }
    target.postMessage({
      kind: VALIDATION_MESSAGE_KINDS.validate,
      requestId: request.requestId,
      schemaHash: request.schemaHash,
      value: request.value,
      fragmentPointer: request.fragmentPointer,
    });
  }

  function request(slot, key, fields) {
    finish(slot);
    requestCount += 1;
    const requestId = requestCount;
    const deadlineTimer = timerFunctions.setTimeout(() => {
      const seconds = Math.round(deadlineMilliseconds / 1000);
      answer(slot, key, [validationFailedProblem(`validation did not answer within ${seconds} seconds`)]);
    }, deadlineMilliseconds);
    const pending = { ...fields, requestId, key, deadlineTimer, resent: false };
    requestsBySlot.set(slot, pending);
    slotsByRequestId.set(requestId, slot);
    send(pending);
  }

  function problemsOf({ slot, ...fields }) {
    const key = requestKeyOf(fields);
    const answered = answersBySlot.get(slot);
    if (answered && answered.key === key) return answered.problems;
    const pending = requestsBySlot.get(slot);
    if (!closed && (!pending || pending.key !== key)) request(slot, key, fields);
    return answered ? answered.problems : null;
  }

  function dropSchema(schemaHash) {
    if (!schemasSent.delete(schemaHash) || !worker) return;
    worker.postMessage({ kind: VALIDATION_MESSAGE_KINDS.dropSchema, schemaHash });
  }

  function dropSlot(slot) {
    finish(slot);
    answersBySlot.delete(slot);
  }

  function whenSettled() {
    if (requestsBySlot.size === 0) return Promise.resolve();
    return new Promise((resolve) => { settledWaiters.push(resolve); });
  }

  function close() {
    closed = true;
    for (const slot of [...requestsBySlot.keys()]) finish(slot);
    if (worker) worker.terminate();
    worker = null;
  }

  return {
    problemsOf,
    onAnswered: (listener) => { answeredListener = listener; },
    dropSchema,
    dropSlot,
    whenSettled,
    close,
  };
}

module.exports = {
  VALIDATION_DEADLINE_MILLISECONDS,
  createInProcessValidation,
  createWorkerValidation,
};

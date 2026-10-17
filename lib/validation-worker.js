const path = require('path');
const { parentPort } = require('worker_threads');
const ajvPackage = require('ajv/package.json');
const { extensionBuildHashOf } = require('./extension-build');
const { VALIDATION_MESSAGE_KINDS, createValidationHost } = require('./validation-host');

const EXTENSION_FOLDER = path.join(__dirname, '..');

function reportProblem(message) {
  parentPort.postMessage({ kind: VALIDATION_MESSAGE_KINDS.log, message });
}

function handleMessage(host, message) {
  if (message.kind === VALIDATION_MESSAGE_KINDS.schema) {
    host.addSchema(message.schemaHash, message.root, message.compiledSchemaFile);
  } else if (message.kind === VALIDATION_MESSAGE_KINDS.dropSchema) {
    host.dropSchema(message.schemaHash);
  } else if (message.kind === VALIDATION_MESSAGE_KINDS.validate) {
    const problems = host.problemsOf(message.schemaHash, message.value, {
      fragmentPointer: message.fragmentPointer,
      allowQuotedValues: message.allowQuotedValues,
    });
    parentPort.postMessage({ kind: VALIDATION_MESSAGE_KINDS.answer, requestId: message.requestId, problems });
  }
}

let hostReady = extensionBuildHashOf(EXTENSION_FOLDER)
  .then((buildHash) => `${buildHash} ajv ${ajvPackage.version}`, (error) => {
    reportProblem(`compiled schemas are not kept: the extension build could not be read: ${error.message}`);
    return null;
  })
  .then((buildKey) => createValidationHost({ buildKey, reportProblem }));

parentPort.on('message', (message) => {
  hostReady = hostReady.then((host) => {
    handleMessage(host, message);
    return host;
  });
});

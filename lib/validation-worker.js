const { parentPort } = require('worker_threads');
const { VALIDATION_MESSAGE_KINDS, createValidationHost } = require('./validation-host');

function reportProblem(message) {
  parentPort.postMessage({ kind: VALIDATION_MESSAGE_KINDS.log, message });
}

const host = createValidationHost({ reportProblem });

parentPort.on('message', (message) => {
  if (message.kind === VALIDATION_MESSAGE_KINDS.schema) {
    host.addSchema(message.schemaHash, message.schemaText, message.schemaStoreFolder);
  } else if (message.kind === VALIDATION_MESSAGE_KINDS.dropSchema) {
    host.dropSchema(message.schemaHash);
  } else if (message.kind === VALIDATION_MESSAGE_KINDS.schemaCapacity) {
    host.setSchemaCapacity(message.capacity);
  } else if (message.kind === VALIDATION_MESSAGE_KINDS.validate) {
    const problems = host.problemsOf(message.schemaHash, message.document, {
      fragmentPointer: message.fragmentPointer,
      validator: message.validator,
    });
    parentPort.postMessage({ kind: VALIDATION_MESSAGE_KINDS.answer, requestId: message.requestId, problems });
  }
});

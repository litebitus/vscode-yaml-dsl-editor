const { parentPort } = require('worker_threads');

parentPort.postMessage({ kind: 'log', message: 'mock worker started' });
parentPort.on('message', (message) => {
  if (message.kind === 'validate') parentPort.postMessage({ kind: 'mock-unknown', requestId: message.requestId });
});

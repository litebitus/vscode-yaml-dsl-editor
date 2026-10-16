const { parentPort } = require('worker_threads');

parentPort.on('message', (message) => {
  if (message.kind === 'validate') process.exit(3);
});

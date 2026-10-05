const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { activateWith } = require('./lib/client');

function startClient(context) {
  const serverModule = context.asAbsolutePath('server.js');
  const client = new LanguageClient(
    'yaml-dsl',
    'YAML DSL',
    {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc },
    },
    { documentSelector: [{ language: 'yaml-dsl' }] },
  );
  client.start();
  return client;
}

function activate(context) {
  return activateWith(vscode, context, startClient);
}

function deactivate() {}

module.exports = { activate, deactivate };

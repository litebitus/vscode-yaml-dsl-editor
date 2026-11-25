const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { activateWith, editorMiddleware } = require('./lib/client');
const { DEFINITION_LANGUAGE } = require('./lib/config');
const { YAML_DSL_LANGUAGE, YAML_DSL_TEMPLATE_LANGUAGE } = require('./lib/dsl-languages');

function startClient(context, configEntries, outputChannel, declarationsPopup, clientWork) {
  const serverModule = context.asAbsolutePath('server.js');
  const client = new LanguageClient(
    'yaml-dsl',
    'YAML DSL',
    {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc },
    },
    {
      documentSelector: [
        { language: YAML_DSL_LANGUAGE },
        { language: YAML_DSL_TEMPLATE_LANGUAGE },
        { language: DEFINITION_LANGUAGE },
      ],
      initializationOptions: { storageFolder: context.globalStorageUri ? context.globalStorageUri.fsPath : null },
      middleware: editorMiddleware(vscode, configEntries, declarationsPopup, clientWork),
      outputChannel,
    },
  );
  client.start();
  return client;
}

function activate(context) {
  return activateWith(vscode, context, startClient);
}

function deactivate() {}

module.exports = { activate, deactivate };

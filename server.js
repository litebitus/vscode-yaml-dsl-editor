const { createConnection, ProposedFeatures, TextDocuments } = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { bind } = require('./lib/bind');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
bind(connection, documents);
documents.listen(connection);
connection.listen();

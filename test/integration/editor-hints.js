const assert = require('assert');
const vscode = require('vscode');

const SAME_IN_COMMON_LAYER = '💡 same in common layer';
const MOVE_TO_COMMON_LAYER = '💡 move to common layer';
const WAIT_DEADLINE_MILLISECONDS = 4000;

async function shownDocument(filePath) {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { preview: false });
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.fsPath, filePath);
  const doc = editor.document;
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  while (doc.languageId !== 'yaml-dsl' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(doc.languageId, 'yaml-dsl');
  return editor;
}

async function hintLabelsOf(doc) {
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  const hints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', doc.uri, range) || [];
  return hints.map((hint) => hint.label[0].value);
}

async function hintLabelsBecome(doc, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  const seenLabels = new Set();
  let labels = [];
  while (Date.now() < deadline) {
    labels = await hintLabelsOf(doc);
    for (const label of labels) seenLabels.add(label);
    if (labels.length === expected.length && labels.every((label, index) => label === expected[index])) {
      return seenLabels;
    }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.deepEqual(labels, expected);
  return seenLabels;
}

module.exports = {
  SAME_IN_COMMON_LAYER,
  MOVE_TO_COMMON_LAYER,
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  hintLabelsOf,
  hintLabelsBecome,
};

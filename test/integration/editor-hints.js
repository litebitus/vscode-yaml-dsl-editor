const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { APPLY_COMMAND } = require('../../lib/suggestion-marks');

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

function fixtureCopy(fixtureFolder, copyLabel = fixtureFolder) {
  const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const copy = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, `${copyLabel}-copy-${vscode.version}`);
  fs.cpSync(path.join(fixtures, fixtureFolder), copy, { recursive: true });
  return copy;
}

async function hintTooltipOf(doc) {
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  const hints = await vscode.commands.executeCommand('vscode.executeInlayHintProvider', doc.uri, range) || [];
  return hints[0].label[0].tooltip.value;
}

function applyArgumentIn(tooltip) {
  const encoded = new RegExp(`\\(command:${APPLY_COMMAND.replace('.', '\\.')}\\?([^)]+)\\)`).exec(tooltip)[1];
  return JSON.parse(decodeURIComponent(encoded));
}

function positionInText(doc, needle, offset = 0) {
  return doc.positionAt(doc.getText().indexOf(needle) + offset);
}

async function hoverTextOf(doc, position) {
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, position) || [];
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n');
}

async function hoverTextBecomes(doc, position, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let text = '';
  while (Date.now() < deadline) {
    text = await hoverTextOf(doc, position);
    if (text === expected) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(text, expected);
}

async function hoverTextHolds(doc, position, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let text = '';
  while (Date.now() < deadline) {
    text = await hoverTextOf(doc, position);
    if (text.includes(expected)) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.ok(text.includes(expected), text);
}

async function typedAfter(editor, needle, text) {
  const doc = editor.document;
  const lineEnd = doc.lineAt(positionInText(doc, needle).line).range.end;
  await editor.edit((edit) => { edit.insert(lineEnd, text); });
  return doc.lineAt(lineEnd.line + text.split('\n').length - 1).range.end;
}

async function completionItemsAt(doc, position) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let items = [];
  while (Date.now() < deadline) {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
    items = list ? list.items : [];
    if (items.length > 0) return items;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return items;
}

async function definitionLineAt(doc, position) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  while (Date.now() < deadline) {
    const definitions = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      doc.uri,
      position,
    ) || [];
    if (definitions.length > 0) return (definitions[0].targetRange || definitions[0].range).start.line;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return null;
}

async function undoInEditorOf(document) {
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('undo');
}

module.exports = {
  SAME_IN_COMMON_LAYER,
  MOVE_TO_COMMON_LAYER,
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  hintLabelsOf,
  hintLabelsBecome,
  fixtureCopy,
  hintTooltipOf,
  applyArgumentIn,
  positionInText,
  hoverTextOf,
  hoverTextBecomes,
  hoverTextHolds,
  typedAfter,
  completionItemsAt,
  definitionLineAt,
  undoInEditorOf,
};

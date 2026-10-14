const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  SAME_IN_COMMON_LAYER,
  MOVE_TO_COMMON_LAYER,
  shownDocument,
  hintLabelsBecome,
} = require('./editor-hints');
const { APPLY_COMMAND } = require('../../lib/suggestion-lightbulbs');

function concernPath(...segments) {
  return path.join(vscode.workspace.workspaceFolders[2].uri.fsPath, ...segments);
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

async function fileTextBecomes(filePath, expected) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === expected) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null, expected);
}

suite('concern common layers', () => {
  test('a concern above its overlays moves a shared block into the common layer in its own directory', async () => {
    const overlay = (await shownDocument(concernPath('concern-1', 'overlay-1', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
    assert.match(await hintTooltipOf(overlay), /\[Move to common layer \(concern-1\/mock\.yml\)\]/);
  });

  test('a concern below its overlays takes its own common layer over the fallback', async () => {
    const overlay = (await shownDocument(concernPath('concern-group', 'overlay-1', 'concern-1', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
  });

  test('a concern below its overlays without a common layer of its own moves into a new one that starts as the fallback', async () => {
    const groupName = `concern-group-moved-${vscode.version}`;
    fs.cpSync(concernPath('concern-group'), concernPath(groupName), { recursive: true });
    const fallbackPath = concernPath(groupName, 'mock.yml');
    const fallbackText = fs.readFileSync(fallbackPath, 'utf8');
    const overlay = (await shownDocument(concernPath(groupName, 'overlay-1', 'concern-2', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
    const tooltip = await hintTooltipOf(overlay);
    assert.ok(tooltip.includes(`[Move to common layer (new ${groupName}/concern-2.mock.yml)]`), tooltip);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(tooltip));
    await fileTextBecomes(
      concernPath(groupName, 'concern-2.mock.yml'),
      'mocktype:\n  fallback:\n    label: mock-fallback\n  shared:\n    label: mock-shared\n',
    );
    assert.equal(fs.readFileSync(fallbackPath, 'utf8'), fallbackText);
    await hintLabelsBecome(overlay, []);
  });
});

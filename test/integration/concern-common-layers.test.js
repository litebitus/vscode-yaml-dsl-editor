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
    if (expected === null && !fs.existsSync(filePath)) return;
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

  test('a concern below its overlays without a common layer of its own moves into a new one holding the fallback blocks its references reach', async () => {
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
      'locals:\n  owner: local.team\n  team: mock-team\nmocktype:\n  shared:\n    label: mock-shared\n    owner: local.owner\n',
    );
    assert.equal(fs.readFileSync(fallbackPath, 'utf8'), fallbackText);
    await hintLabelsBecome(overlay, []);
  });

  test('undoing a move that created a concern\'s common layer removes the file and saves the overlays it restored', async () => {
    const groupName = `concern-group-undone-${vscode.version}`;
    fs.cpSync(concernPath('concern-group'), concernPath(groupName), { recursive: true });
    const overlayPath = concernPath(groupName, 'overlay-1', 'concern-2', 'mock.yml');
    const overlayText = fs.readFileSync(overlayPath, 'utf8');
    const concernFile = concernPath(groupName, 'concern-2.mock.yml');
    const overlay = (await shownDocument(overlayPath)).document;
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(overlay)));
    await fileTextBecomes(overlayPath, '');
    const concernSaves = [];
    const saveWatch = vscode.workspace.onWillSaveTextDocument((event) => {
      if (event.document.uri.fsPath === concernFile) concernSaves.push(event.document.getText());
    });
    try {
      await vscode.commands.executeCommand('undo');
      await fileTextBecomes(overlayPath, overlayText);
      await fileTextBecomes(concernFile, null);
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    } finally {
      saveWatch.dispose();
    }
    assert.deepEqual(concernSaves, []);
    assert.equal(fs.existsSync(concernFile), false);
  });

  test('a move takes the comments above the keys it deletes and writes the first overlay\'s into the common layer', async () => {
    const groupName = `commented-move-${vscode.version}`;
    fs.cpSync(concernPath('commented-move'), concernPath(groupName), { recursive: true });
    const overlay = (await shownDocument(concernPath(groupName, 'overlay-1', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, [MOVE_TO_COMMON_LAYER]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(overlay)));
    await fileTextBecomes(concernPath(groupName, 'mock.yml'), [
      'base:',
      '  kept:',
      '    label: mock-kept',
      '',
      '# mock section note one',
      'mocktype:',
      '  # mock unit note one',
      '  shared:',
      '    label: mock-shared',
      '',
    ].join('\n'));
    await fileTextBecomes(concernPath(groupName, 'overlay-1', 'mock.yml'), 'one: 1\n');
    await fileTextBecomes(concernPath(groupName, 'overlay-2', 'mock.yml'), 'two: 2\n');
  });

  test('a delete takes the comment above the key it deletes', async () => {
    const groupName = `commented-delete-${vscode.version}`;
    fs.cpSync(concernPath('commented-delete'), concernPath(groupName), { recursive: true });
    const overlay = (await shownDocument(concernPath(groupName, 'overlay-1', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER]);
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgumentIn(await hintTooltipOf(overlay)));
    await fileTextBecomes(
      concernPath(groupName, 'overlay-1', 'mock.yml'),
      'mocktype:\n  own:\n    label: mock-own\n',
    );
  });
});

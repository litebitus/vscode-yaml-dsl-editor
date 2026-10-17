const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  SAME_IN_COMMON_LAYER,
  MOVE_TO_COMMON_LAYER,
  shownDocument,
  hintLabelsBecome,
  positionInText,
  hoverTextBecomes,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const POTENTIAL_MOVE = 'ⓘ potential move: one difference, size';
const RENAME_EVERYWHERE = '💡 rename everywhere: shared → renamed';
const EVERY_KIND = [SAME_IN_COMMON_LAYER, POTENTIAL_MOVE, MOVE_TO_COMMON_LAYER];

function settingsPath(...segments) {
  return path.join(vscode.workspace.workspaceFolders[3].uri.fsPath, ...segments);
}

async function withSetting(key, value, body) {
  const settings = vscode.workspace.getConfiguration('yaml-dsl-editor');
  await settings.update(key, value, vscode.ConfigurationTarget.Global);
  try {
    await body();
  } finally {
    await settings.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

suite('feature settings', () => {
  isolateEachTest();

  test('each suggestion kind is shown until its own setting turns it off', async () => {
    const overlay = (await shownDocument(settingsPath('kinds', 'overlay-1', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, EVERY_KIND);
    await withSetting('suggestion.delete.enabled', false, () => hintLabelsBecome(overlay, [
      POTENTIAL_MOVE,
      MOVE_TO_COMMON_LAYER,
    ]));
    await withSetting('suggestion.potentialMove.enabled', false, () => hintLabelsBecome(overlay, [
      SAME_IN_COMMON_LAYER,
      MOVE_TO_COMMON_LAYER,
    ]));
    await withSetting('suggestion.move.enabled', false, () => hintLabelsBecome(overlay, [
      SAME_IN_COMMON_LAYER,
      POTENTIAL_MOVE,
    ]));
    await hintLabelsBecome(overlay, EVERY_KIND);
  });

  test('the deprecated features.suggestions turns off every suggestion kind not set on its own', async () => {
    const overlay = (await shownDocument(settingsPath('kinds', 'overlay-1', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, EVERY_KIND);
    await withSetting('features.suggestions', 'off', () => hintLabelsBecome(overlay, []));
    await hintLabelsBecome(overlay, EVERY_KIND);
  });

  test('a rename suggestion is shown until suggestion.rename.enabled turns it off', async () => {
    const stackName = `kinds-renamed-${vscode.version}`;
    fs.cpSync(settingsPath('kinds'), settingsPath(stackName), { recursive: true });
    const editor = await shownDocument(settingsPath(stackName, 'overlay-1', 'mock.yml'));
    const overlay = editor.document;
    await hintLabelsBecome(overlay, EVERY_KIND);
    const sharedKey = overlay.positionAt(overlay.getText().indexOf('shared:'));
    await editor.edit((edit) => {
      edit.replace(new vscode.Range(sharedKey, sharedKey.translate(0, 'shared'.length)), 'renamed');
    });
    await hintLabelsBecome(overlay, [SAME_IN_COMMON_LAYER, POTENTIAL_MOVE, RENAME_EVERYWHERE]);
    await withSetting('suggestion.rename.enabled', false, () => hintLabelsBecome(overlay, [
      SAME_IN_COMMON_LAYER,
      POTENTIAL_MOVE,
    ]));
  });

  test('a deprecated field\'s warning is its hover until warning.deprecation.enabled turns it off', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'drafts', 'draft-2019-09', 'mock.yml'))).document;
    const key = positionInText(doc, 'old');
    const value = positionInText(doc, 'old: ', 'old: '.length);
    const warning = '`old` is deprecated: use pair';
    await hoverTextBecomes(doc, value, warning);
    const documentation = '`old`    `[optional]`\n\nuse pair\n\n*Deprecated*';
    await withSetting('warning.deprecation.enabled', false, async () => {
      await hoverTextBecomes(doc, key, documentation);
      await hoverTextBecomes(doc, value, documentation);
    });
    await hoverTextBecomes(doc, key, warning);
  });
});

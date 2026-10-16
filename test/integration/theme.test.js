const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  fixtureCopy,
  positionInText,
  hoverTextBecomes,
  hintLabelsBecome,
} = require('./editor-hints');
const { writeOverlays, overlayHeadingOf } = require('./overlay-schema-folders');

const SETTINGS_SECTION = 'yaml-dsl-editor';

suite('themes', () => {
  teardown(async () => {
    const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    await settings.update('theme', undefined, vscode.ConfigurationTarget.Global);
    const workbenchSettings = vscode.workspace.getConfiguration('workbench');
    await workbenchSettings.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
  });

  test('the title bar toggle switches the editor between light and dark, and the extension\'s theme with it', async () => {
    const stack = fixtureCopy('stack', 'toggled-theme');
    writeOverlays(stack, { one: 'Label of one', two: 'Label of two' });
    fs.writeFileSync(path.join(stack, 'mock.yml'), 'mocktype:\n  shared:\n    label: mock\n');
    const common = (await shownDocument(path.join(stack, 'mock.yml'))).document;
    const label = positionInText(common, 'label: mock', 1);
    const hoverIn = (theme) => ['one', 'two']
      .map((overlayName) => `${overlayHeadingOf(overlayName, theme)}\n\n\`\`\`\nlabel: string    [optional]\n\`\`\`\n\n`
        + `Label of ${overlayName}`)
      .join('\n\n');
    const editorThemeIsLight = () => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light;
    await hoverTextBecomes(common, label, hoverIn('dark'));
    await vscode.commands.executeCommand('yaml-dsl-editor.toggleTheme');
    await hoverTextBecomes(common, label, hoverIn('light'));
    assert.equal(editorThemeIsLight(), true);
    await vscode.commands.executeCommand('yaml-dsl-editor.toggleTheme');
    await hoverTextBecomes(common, label, hoverIn('dark'));
    assert.equal(editorThemeIsLight(), false);
  });

  test('a suggestion\'s inlay hint opens with the light bulb in the dark theme and with a ✦ in the light theme', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const overlay = (await shownDocument(path.join(fixtures, 'suggest', 'one', 'mock.yml'))).document;
    await hintLabelsBecome(overlay, ['💡 move to common layer']);
    await vscode.commands.executeCommand('yaml-dsl-editor.toggleTheme');
    await hintLabelsBecome(overlay, ['✦ move to common layer']);
    await vscode.commands.executeCommand('yaml-dsl-editor.toggleTheme');
    await hintLabelsBecome(overlay, ['💡 move to common layer']);
  });
});

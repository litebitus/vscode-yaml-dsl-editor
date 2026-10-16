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
  WAIT_DEADLINE_MILLISECONDS,
} = require('./editor-hints');
const { writeOverlays, overlayHeadingOf } = require('./overlay-schema-folders');
const { isolateEachTest } = require('./test-isolation');

const SETTINGS_SECTION = 'yaml-dsl-editor';

function editorThemeStateText() {
  const workbenchSettings = vscode.workspace.getConfiguration('workbench');
  return JSON.stringify({
    kind: vscode.window.activeColorTheme.kind,
    colorTheme: workbenchSettings.get('colorTheme'),
    preferredLightColorTheme: workbenchSettings.get('preferredLightColorTheme'),
    preferredDarkColorTheme: workbenchSettings.get('preferredDarkColorTheme'),
    autoDetectColorScheme: vscode.workspace.getConfiguration('window').get('autoDetectColorScheme'),
    extensionTheme: vscode.workspace.getConfiguration(SETTINGS_SECTION).get('theme'),
  });
}

async function editorThemeBecomes(light) {
  const lightKinds = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight];
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  while (lightKinds.includes(vscode.window.activeColorTheme.kind) !== light && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(lightKinds.includes(vscode.window.activeColorTheme.kind), light, editorThemeStateText());
}

suite('themes', () => {
  isolateEachTest();

  setup(async () => {
    const windowSettings = vscode.workspace.getConfiguration('window');
    await windowSettings.update('autoDetectColorScheme', false, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    await settings.update('theme', undefined, vscode.ConfigurationTarget.Global);
    const workbenchSettings = vscode.workspace.getConfiguration('workbench');
    await workbenchSettings.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    const windowSettings = vscode.workspace.getConfiguration('window');
    await windowSettings.update('autoDetectColorScheme', undefined, vscode.ConfigurationTarget.Global);
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
    await editorThemeBecomes(false);
    await hoverTextBecomes(common, label, hoverIn('dark'));
    await vscode.commands.executeCommand('yaml-dsl-editor.toggleTheme');
    await editorThemeBecomes(true);
    await hoverTextBecomes(common, label, hoverIn('light'));
    await vscode.commands.executeCommand('yaml-dsl-editor.toggleTheme');
    await editorThemeBecomes(false);
    await hoverTextBecomes(common, label, hoverIn('dark'));
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

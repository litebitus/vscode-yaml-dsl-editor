const test = require('node:test');
const assert = require('node:assert/strict');
const {
  themeOfSetting,
  editorThemeIsLight,
  activeThemeOf,
  themeColorId,
  themeColorVariable,
  gutterMarkPath,
  overlayDiffRole,
} = require('../lib/themes');

const COLOR_THEME_KINDS = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

function editorWith(themeSetting, colorThemeKind) {
  return {
    ColorThemeKind: COLOR_THEME_KINDS,
    window: { activeColorTheme: { kind: colorThemeKind } },
    workspace: { getConfiguration: () => ({ get: (key) => (key === 'theme' ? themeSetting : undefined) }) },
  };
}

test('auto follows the editor, light for a light or high contrast light theme, and a named theme is kept', () => {
  assert.equal(activeThemeOf(editorWith('auto', COLOR_THEME_KINDS.Light)), 'light');
  assert.equal(activeThemeOf(editorWith('auto', COLOR_THEME_KINDS.HighContrastLight)), 'light');
  assert.equal(activeThemeOf(editorWith('auto', COLOR_THEME_KINDS.Dark)), 'dark');
  assert.equal(activeThemeOf(editorWith('auto', COLOR_THEME_KINDS.HighContrast)), 'dark');
  assert.equal(activeThemeOf(editorWith('dark', COLOR_THEME_KINDS.Light)), 'dark');
  assert.equal(activeThemeOf(editorWith('light', COLOR_THEME_KINDS.Dark)), 'light');
  assert.equal(themeOfSetting(undefined, false), 'dark');
  assert.equal(editorThemeIsLight({ window: {} }), false);
});

test('a role is a theme color per theme, its CSS variable and its gutter mark drawn per theme', () => {
  assert.equal(themeColorId('light', overlayDiffRole(2)), 'yamlDslEditor.light.overlayDiff.difference2');
  assert.equal(
    themeColorVariable('dark', 'declaration.keyForeground'),
    'var(--vscode-yamlDslEditor-dark-declaration-keyForeground)',
  );
  assert.equal(gutterMarkPath('light', 'error'), 'media/light/error-gutter-mark.svg');
});

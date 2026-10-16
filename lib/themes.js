const { SETTINGS_SECTION } = require('./feature-settings');

const DARK_THEME = 'dark';
const LIGHT_THEME = 'light';
const AUTO_THEME_SETTING = 'auto';
const THEME_SETTING_KEY = 'theme';
const THEME_COLOR_PREFIX = 'yamlDslEditor';
const THEME_ROLES = {
  error: 'errorForeground',
  warning: 'warningForeground',
  info: 'infoForeground',
  suggestion: 'suggestionForeground',
  overlayHeading: 'overlayHeadingForeground',
  validationErrorsHeading: 'validationErrorsHeadingForeground',
  declarationKey: 'declaration.keyForeground',
  declarationString: 'declaration.stringForeground',
  declarationComment: 'declaration.commentForeground',
  declarationReference: 'declaration.referenceForeground',
  declarationPlaceholder: 'declaration.placeholderForeground',
};
const GUTTER_MARK_FILES = {
  error: 'error-gutter-mark.svg',
  warning: 'warning-gutter-mark.svg',
  info: 'info-gutter-mark.svg',
  suggestion: 'suggestion-gutter-mark.svg',
};

function overlayDiffRole(differenceNumber) {
  return `overlayDiff.difference${differenceNumber}`;
}

function themeColorId(theme, role) {
  return `${THEME_COLOR_PREFIX}.${theme}.${role}`;
}

function themeColorVariable(theme, role) {
  return `var(--vscode-${themeColorId(theme, role).replaceAll('.', '-')})`;
}

function gutterMarkPath(theme, mark) {
  return `media/${theme}/${GUTTER_MARK_FILES[mark]}`;
}

function themeOfSetting(themeSetting, editorThemeIsLight) {
  if (themeSetting === DARK_THEME || themeSetting === LIGHT_THEME) return themeSetting;
  return editorThemeIsLight ? LIGHT_THEME : DARK_THEME;
}

function editorThemeIsLight(vscode) {
  const kinds = vscode.ColorThemeKind;
  const activeColorTheme = vscode.window && vscode.window.activeColorTheme;
  if (!kinds || !activeColorTheme) return false;
  return activeColorTheme.kind === kinds.Light || activeColorTheme.kind === kinds.HighContrastLight;
}

function activeThemeOf(vscode) {
  const themeSetting = vscode.workspace.getConfiguration(SETTINGS_SECTION).get(THEME_SETTING_KEY);
  return themeOfSetting(themeSetting, editorThemeIsLight(vscode));
}

module.exports = {
  DARK_THEME,
  LIGHT_THEME,
  AUTO_THEME_SETTING,
  THEME_SETTING_KEY,
  THEME_ROLES,
  overlayDiffRole,
  themeColorId,
  themeColorVariable,
  gutterMarkPath,
  themeOfSetting,
  editorThemeIsLight,
  activeThemeOf,
};

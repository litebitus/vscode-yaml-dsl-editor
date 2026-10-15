const SETTINGS_SECTION = 'yaml-dsl-editor';
const DEPRECATED_SUGGESTIONS_KEY = 'features.suggestions';
const FEATURE_SETTING_GROUPS = ['suggestion', 'warning', 'validator', DEPRECATED_SUGGESTIONS_KEY];
const SUGGESTION_KIND_HAS_FILE_DECORATION = {
  delete: true,
  move: true,
  potentialMove: false,
  rename: true,
};
const EXPLICIT_VALUE_SCOPES = [
  'globalValue',
  'workspaceValue',
  'workspaceFolderValue',
  'globalLanguageValue',
  'workspaceLanguageValue',
  'workspaceFolderLanguageValue',
];

function explicitlySet(settings, key) {
  const inspected = typeof settings.inspect === 'function' ? settings.inspect(key) : null;
  return Boolean(inspected) && EXPLICIT_VALUE_SCOPES.some((scope) => inspected[scope] !== undefined);
}

const featureSettingsByEditor = new WeakMap();

function featureSettingsOf(vscode) {
  if (!featureSettingsByEditor.has(vscode)) featureSettingsByEditor.set(vscode, readFeatureSettings(vscode));
  return featureSettingsByEditor.get(vscode);
}

function forgetFeatureSettings(vscode) {
  featureSettingsByEditor.delete(vscode);
}

function readFeatureSettings(vscode) {
  const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const turnedOn = (key) => settings.get(key) !== false;
  const featureOf = (prefix, enabled, hasFileDecoration) => ({
    enabled,
    fileDecoration: enabled && hasFileDecoration && turnedOn(`${prefix}.fileDecoration`),
  });
  const suggestionsOnByDeprecatedKey = settings.get(DEPRECATED_SUGGESTIONS_KEY) !== 'off';
  const suggestionEnabled = (prefix) => (explicitlySet(settings, `${prefix}.enabled`)
    ? turnedOn(`${prefix}.enabled`)
    : suggestionsOnByDeprecatedKey);
  const suggestion = {};
  for (const [kind, hasFileDecoration] of Object.entries(SUGGESTION_KIND_HAS_FILE_DECORATION)) {
    const prefix = `suggestion.${kind}`;
    suggestion[kind] = featureOf(prefix, suggestionEnabled(prefix), hasFileDecoration);
  }
  const deprecationPrefix = 'warning.deprecation';
  const validatorEnabled = turnedOn('validator.enabled');
  return {
    suggestion,
    warning: { deprecation: featureOf(deprecationPrefix, turnedOn(`${deprecationPrefix}.enabled`), true) },
    validator: {
      enabled: validatorEnabled,
      errorSeverity: settings.get('validator.errorSeverity'),
      fileDecoration: validatorEnabled && settings.get('validator.fileDecoration') === true,
    },
  };
}

function featureSettingsAffected(event) {
  return FEATURE_SETTING_GROUPS.some((group) => event.affectsConfiguration(`${SETTINGS_SECTION}.${group}`));
}

module.exports = { SETTINGS_SECTION, featureSettingsOf, forgetFeatureSettings, featureSettingsAffected };

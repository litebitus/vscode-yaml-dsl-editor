const test = require('node:test');
const assert = require('node:assert/strict');
const { featureSettingsOf, featureSettingsAffected } = require('../lib/feature-settings');
const { contributes } = require('../package.json');

const SETTING_DEFAULTS = Object.fromEntries(Object.entries(contributes.configuration.properties)
  .map(([key, setting]) => [key.replace(/^yaml-dsl-editor\./, ''), setting.default]));

function vscodeWith(values, explicitKeys = Object.keys(values)) {
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key) => (Object.hasOwn(values, key) ? values[key] : SETTING_DEFAULTS[key]),
        inspect: (key) => (explicitKeys.includes(key) ? { globalValue: values[key] } : {}),
      }),
    },
  };
}

const ALL_ON = {
  suggestion: {
    delete: { enabled: true, fileDecoration: true },
    move: { enabled: true, fileDecoration: true },
    potentialMove: { enabled: true, fileDecoration: false },
    rename: { enabled: true, fileDecoration: true },
  },
  warning: { deprecation: { enabled: true, fileDecoration: true } },
  validator: { enabled: true, errorSeverity: 'warning', fileDecoration: false },
};

test('every feature and its file decoration are on by default, and a potential move has no file decoration', () => {
  assert.deepEqual(featureSettingsOf(vscodeWith({ 'features.suggestions': 'on' }, [])), ALL_ON);
  assert.deepEqual(featureSettingsOf(vscodeWith({ 'suggestion.potentialMove.fileDecoration': true })), ALL_ON);
});

test('each suggestion kind turns off on its own, its file decoration with it', () => {
  for (const kind of Object.keys(ALL_ON.suggestion)) {
    const settings = featureSettingsOf(vscodeWith({ [`suggestion.${kind}.enabled`]: false }));
    assert.deepEqual(settings.suggestion[kind], { enabled: false, fileDecoration: false });
    for (const otherKind of Object.keys(ALL_ON.suggestion).filter((other) => other !== kind)) {
      assert.deepEqual(settings.suggestion[otherKind], ALL_ON.suggestion[otherKind]);
    }
  }
});

test('a file decoration turns off on its own', () => {
  const settings = featureSettingsOf(vscodeWith({
    'suggestion.delete.fileDecoration': false,
    'suggestion.move.fileDecoration': false,
    'suggestion.rename.fileDecoration': false,
    'warning.deprecation.fileDecoration': false,
  }));
  assert.deepEqual(settings, {
    suggestion: {
      delete: { enabled: true, fileDecoration: false },
      move: { enabled: true, fileDecoration: false },
      potentialMove: { enabled: true, fileDecoration: false },
      rename: { enabled: true, fileDecoration: false },
    },
    warning: { deprecation: { enabled: true, fileDecoration: false } },
    validator: { enabled: true, errorSeverity: 'warning', fileDecoration: false },
  });
});

test('validation errors take their severity from the setting, and validation turned off takes its file decoration', () => {
  const shown = featureSettingsOf(vscodeWith({ 'validator.errorSeverity': 'error', 'validator.fileDecoration': true }));
  assert.deepEqual(shown.validator, { enabled: true, errorSeverity: 'error', fileDecoration: true });
  const off = featureSettingsOf(vscodeWith({ 'validator.enabled': false, 'validator.fileDecoration': true }));
  assert.deepEqual([off.validator.enabled, off.validator.fileDecoration], [false, false]);
});

test('deprecation warnings turned off take their file decoration with them', () => {
  const settings = featureSettingsOf(vscodeWith({
    'warning.deprecation.enabled': false,
    'warning.deprecation.fileDecoration': true,
  }));
  assert.deepEqual(settings.warning.deprecation, { enabled: false, fileDecoration: false });
});

test('the deprecated features.suggestions is read for each suggestion kind not set on its own', () => {
  const offByDeprecatedKey = vscodeWith(
    { 'features.suggestions': 'off', 'suggestion.move.enabled': true },
    ['features.suggestions', 'suggestion.move.enabled'],
  );
  const { suggestion } = featureSettingsOf(offByDeprecatedKey);
  assert.deepEqual(Object.fromEntries(Object.entries(suggestion).map(([kind, setting]) => [kind, setting.enabled])), {
    delete: false,
    move: true,
    potentialMove: false,
    rename: false,
  });
});

test('a change to either group or the deprecated key affects the feature settings', () => {
  const changed = (setting) => ({ affectsConfiguration: (section) => section === setting });
  assert.equal(featureSettingsAffected(changed('yaml-dsl-editor.suggestion')), true);
  assert.equal(featureSettingsAffected(changed('yaml-dsl-editor.warning')), true);
  assert.equal(featureSettingsAffected(changed('yaml-dsl-editor.validator')), true);
  assert.equal(featureSettingsAffected(changed('yaml-dsl-editor.features.suggestions')), true);
  assert.equal(featureSettingsAffected(changed('yaml-dsl-editor.cache')), false);
});

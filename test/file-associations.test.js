const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YAML_DSL_LANGUAGE,
  associationPathKeyOf,
  fileAssociationsOf,
  withFileAssociations,
  withAddedFileAssociations,
  sameAssociations,
} = require('../lib/file-associations');
const { parsedDsl, dslEntry } = require('./config-builders');

const MOCK_HOME = '/mock-home';

function workspaceSettings(workspaceValue, userValue = undefined) {
  return { workspaceValue, userValue, homeFolder: MOCK_HOME };
}

function dslIn(dir, fields) {
  return { ...parsedDsl(dslEntry('mock', fields)), dir };
}

test('a DSL\'s include globs are associated anchored at its config folder, each as the files it claims', () => {
  const associations = fileAssociationsOf([
    dslIn('/mock-repo/examples/mock-dsl', {
      file_includes: [
        '{config_root}/**/*.yaml',
        '**/mock.yml',
        '/mock-repo/examples/mock-dsl/fixed.yml',
        '/mock-elsewhere/fixed.yml',
        'mock-relative/*.yml',
      ],
    }),
  ]);
  assert.deepEqual(associations, {
    '/mock-repo/examples/mock-dsl/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-repo/examples/mock-dsl/**/mock.yml': YAML_DSL_LANGUAGE,
    '/mock-repo/examples/mock-dsl/fixed.yml': YAML_DSL_LANGUAGE,
  });
});

test('a concern\'s common layer names are associated, and a DSL with no config folder associates nothing', () => {
  const layered = dslIn('/mock-repo', {
    file_includes: [],
    layers: {
      overlay_folders: ['one'],
      common_layer_discovery: 'ancestor',
      common_layer_files: { 'mock.yml': ['{concern}.mock.yml', 'mock.yml'] },
      duplicate_check: { depth: 2, key_depths: {}, skip_keys: [] },
    },
  });
  assert.deepEqual(fileAssociationsOf([layered]), { '/mock-repo/**/*.mock.yml': YAML_DSL_LANGUAGE });
  assert.deepEqual(fileAssociationsOf([{ ...layered, dir: undefined }]), {});
});

test('a character the editor reads as glob syntax is bracketed, and a glob holding one it cannot is left out', () => {
  const associations = fileAssociationsOf([
    dslIn('/mock-repo/mock{dsl}', { file_includes: ['{config_root}/mock?[1].yml', '{config_root}/plain.yml'] }),
  ]);
  assert.deepEqual(associations, { '/mock-repo/mock[{]dsl[}]/plain.yml': YAML_DSL_LANGUAGE });
  const opened = fileAssociationsOf([dslIn('/mock-repo', { file_includes: ['{config_root}/mock?[.yml'] })]);
  assert.deepEqual(opened, { '/mock-repo/mock[?][[].yml': YAML_DSL_LANGUAGE });
});

test('updating the associations adds the DSLs\', drops a stale one the extension wrote, and keeps every other', () => {
  const current = {
    '*.mock': 'mock-language',
    '/mock-repo/old/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-repo/kept/**/*.yaml': YAML_DSL_LANGUAGE,
  };
  const owned = { '/mock-repo/kept/**/*.yaml': YAML_DSL_LANGUAGE, '/mock-repo/new/**/*.yaml': YAML_DSL_LANGUAGE };
  const updated = withFileAssociations(workspaceSettings(current), owned);
  assert.deepEqual(updated, {
    '*.mock': 'mock-language',
    '/mock-repo/kept/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-repo/new/**/*.yaml': YAML_DSL_LANGUAGE,
  });
  assert.equal(sameAssociations(current, updated), false);
  assert.equal(sameAssociations(updated, withFileAssociations(workspaceSettings(updated), owned)), true);
  assert.deepEqual(withFileAssociations(workspaceSettings(undefined), owned), owned);
  assert.equal(sameAssociations({ a: 'x' }, { b: 'x' }), false);
});

test('another language\'s entry for a DSL glob is left as written and the glob is not added beside it', () => {
  const current = { '/mock-repo/**/*.yaml': 'yaml' };
  const owned = { '/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE };
  assert.deepEqual(withFileAssociations(workspaceSettings(current), owned), current);
  assert.deepEqual(withFileAssociations(workspaceSettings(current), {}), current);
});

test('adding associations keeps every entry already written', () => {
  const current = { '*.mock': 'mock-language', '/mock-repo/unread/**/*.yaml': YAML_DSL_LANGUAGE };
  const owned = { '/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE };
  assert.deepEqual(withAddedFileAssociations(workspaceSettings(current), owned), { ...current, ...owned });
  assert.deepEqual(withAddedFileAssociations(workspaceSettings(undefined), owned), owned);
});

test('a path pattern reads the same however its path is spelled', () => {
  const sameKey = (pattern) => associationPathKeyOf(pattern, MOCK_HOME);
  assert.equal(sameKey('~/mock-repo/**/*.yaml'), '/mock-home/mock-repo/**/*.yaml');
  assert.equal(sameKey('~'), '/mock-home');
  assert.equal(sameKey('/mock-home//mock-repo/./nested/../**/*.yaml'), '/mock-home/mock-repo/**/*.yaml');
  assert.equal(sameKey('/mock-home/mock-repo/'), '/mock-home/mock-repo');
  assert.equal(sameKey('C:\\mock-repo\\**\\*.yaml'), 'c:/mock-repo/**/*.yaml');
  assert.equal(sameKey('/'), '/');
  assert.equal(sameKey('**/*.yaml'), '**/*.yaml');
  assert.equal(sameKey('~mock-user/*.yaml'), '~mock-user/*.yaml');
});

test('a glob already associated, in any spelling or in user settings, is not added again', () => {
  const owned = {
    '/mock-home/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-home/mock-repo/**/*.yml': YAML_DSL_LANGUAGE,
    '/mock-home/mock-repo/**/*.json': YAML_DSL_LANGUAGE,
  };
  const current = { '~/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE };
  const userValue = { '/mock-home/mock-repo/./**/*.yml': 'yaml' };
  assert.deepEqual(withFileAssociations(workspaceSettings(current, userValue), owned), {
    '~/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-home/mock-repo/**/*.json': YAML_DSL_LANGUAGE,
  });
});

test('a YAML DSL entry repeating a glob already associated is dropped, and a stale one in any spelling too', () => {
  const owned = { '/mock-home/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE };
  const current = {
    '/mock-home/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE,
    '~/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE,
    '~/mock-gone/**/*.yaml': YAML_DSL_LANGUAGE,
  };
  assert.deepEqual(withFileAssociations(workspaceSettings(current), owned), owned);
  const otherLanguage = { ...owned, '~/mock-repo/**/*.yaml': 'yaml' };
  for (const update of [withFileAssociations, withAddedFileAssociations]) {
    assert.deepEqual(update(workspaceSettings(otherLanguage), owned), { '~/mock-repo/**/*.yaml': 'yaml' });
  }
  const userValue = { '~/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE };
  assert.deepEqual(withFileAssociations(workspaceSettings({ ...owned }, userValue), owned), {});
});

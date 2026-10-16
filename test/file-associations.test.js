const test = require('node:test');
const assert = require('node:assert/strict');
const {
  YAML_DSL_LANGUAGE,
  fileAssociationsOf,
  withFileAssociations,
  withAddedFileAssociations,
  sameAssociations,
} = require('../lib/file-associations');
const { parsedDsl, dslEntry } = require('./config-builders');

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

test('updating the associations keeps every other language\'s entry, adds the DSLs\' and drops a stale one', () => {
  const current = {
    '*.mock': 'mock-language',
    '/mock-repo/old/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-repo/kept/**/*.yaml': YAML_DSL_LANGUAGE,
  };
  const owned = { '/mock-repo/kept/**/*.yaml': YAML_DSL_LANGUAGE, '/mock-repo/new/**/*.yaml': YAML_DSL_LANGUAGE };
  const updated = withFileAssociations(current, owned);
  assert.deepEqual(updated, {
    '*.mock': 'mock-language',
    '/mock-repo/kept/**/*.yaml': YAML_DSL_LANGUAGE,
    '/mock-repo/new/**/*.yaml': YAML_DSL_LANGUAGE,
  });
  assert.equal(sameAssociations(current, updated), false);
  assert.equal(sameAssociations(updated, withFileAssociations(updated, owned)), true);
  assert.deepEqual(withFileAssociations(undefined, owned), owned);
  assert.equal(sameAssociations({ a: 'x' }, { b: 'x' }), false);
});

test('adding associations keeps every entry already written, the DSLs\' own included', () => {
  const current = { '*.mock': 'mock-language', '/mock-repo/unread/**/*.yaml': YAML_DSL_LANGUAGE };
  const owned = { '/mock-repo/**/*.yaml': YAML_DSL_LANGUAGE };
  assert.deepEqual(withAddedFileAssociations(current, owned), { ...current, ...owned });
  assert.deepEqual(withAddedFileAssociations(undefined, owned), owned);
});

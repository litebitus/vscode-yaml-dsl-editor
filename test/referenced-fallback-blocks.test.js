const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');
const { createNodeIds } = require('../lib/node-ids');
const { referencedFallbackPaths, referencedFallbackText } = require('../lib/referenced-fallback-blocks');
const {
  scope,
  declaration,
  reference,
  dslEntry,
  parsedDsl,
} = require('./config-builders');

const dsl = parsedDsl(dslEntry('sample', {
  layers: {
    overlay_folders: ['dev', 'staging'],
    common_layer_discovery: 'ancestor',
    duplicate_check: { depth: 2, key_depths: {}, skip_keys: ['schema_version'] },
  },
  locals: { scope_name: 'local' },
  scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
  declarations: [
    declaration('$.locals.*', 'local', { key_token: 'first_word' }),
    declaration('$.*.*', 'ENTRY', { skip_keys: ['locals'], key_token: 'last_word' }),
  ],
  references: [
    reference('^local\\.(?<name>[a-z0-9_]+)$', 'local'),
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', 'ENTRY', {
      scope_group: 'type',
      text_after_name_allowed: true,
    }),
  ],
}));

function docsOf(texts) {
  const nodeIds = createNodeIds();
  return Object.entries(texts).map(([filePath, text]) => analyzeDocument(text, filePath, dsl, nodeIds));
}

const NO_SEED = { text: '', keys: [] };

test('the fallback blocks kept are those the overlays\' references reach, and the references inside them', () => {
  const [fallback, dev, staging] = docsOf({
    '/repo/mock.yml': [
      'schema_version: "3"',
      '',
      '# mock section note',
      'data_source:',
      '  unused_key:',
      '    type: mock',
      '',
      '  # mock key note',
      '  data_key:',
      '    type: mock',
      '    region: local.region',
      'locals:',
      '  region: mock-region',
      '  owner: mock-owner',
      'cluster:',
      '  defaults:',
      '    key: ref data_source.data_key.arn',
      '',
    ].join('\n'),
    '/repo/dev/config/mock.yml': 'queue:\n  main:\n    key: ref data_source.data_key.arn\n    owner: local.owner\n',
    '/repo/staging/config/mock.yml': 'locals:\n  owner: mock-staging-owner\nqueue:\n  main:\n    owner: local.owner\n',
  });
  assert.deepEqual(referencedFallbackPaths(fallback, [dev, staging], dsl), [
    ['data_source', 'data_key'],
    ['locals', 'owner'],
    ['locals', 'region'],
  ]);
  assert.equal(referencedFallbackText(fallback, [dev, staging], dsl, { text: 'schema_version: "3"\n', keys: ['schema_version'] }), [
    'schema_version: "3"',
    '',
    '# mock section note',
    'data_source:',
    '  # mock key note',
    '  data_key:',
    '    type: mock',
    '    region: local.region',
    'locals:',
    '  region: mock-region',
    '  owner: mock-owner',
    '',
  ].join('\n'));
});

test('a fallback no reference reaches, or one that is not a block map, leaves only the seed', () => {
  const seed = { text: 'schema_version: "3"\n', keys: ['schema_version'] };
  const [fallback, dev] = docsOf({ '/repo/mock.yml': 'locals:\n  owner: x\n', '/repo/dev/mock.yml': 'queue: {}\n' });
  assert.equal(referencedFallbackText(fallback, [dev], dsl, seed), seed.text);
  const [flow, flowDev] = docsOf({ '/repo/mock.yml': '{locals: {owner: x}}\n', '/repo/dev/mock.yml': 'a: local.owner\n' });
  assert.equal(referencedFallbackText(flow, [flowDev], dsl, NO_SEED), '');
});

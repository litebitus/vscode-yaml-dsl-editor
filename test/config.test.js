const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMON_LAYER_DISCOVERIES,
  CONFIG_VERSIONS,
  FUNCTION_DEFINITIONS,
  KEY_ORDERS,
  KEY_TOKENS,
  LOGICAL_SCOPE_NAME,
  NAME_SOURCES,
  NAME_SPELLINGS,
  parseConfig,
  claimFile,
  ownsFile,
} = require('../lib/config');
const { REFERENCE_POSITIONS } = require('../lib/reference-positions');
const {
  scope,
  declaration,
  reference,
  dslEntry,
  configText,
} = require('./config-builders');

const completeConfig = `
version: "1"
dsls:
  - id: resources
    file_includes: ["**/mock.yml", 1]
    file_excludes: ["**/skip/**"]
    schema_search_paths: [https://example.test/schema.json]
    layers:
      overlay_folders: [one, 2]
      common_layer_discovery: ancestor
      duplicate_check:
        depth: 3
        key_depths: { data_source: 2 }
        skip_keys: [schema_version]
    placeholder:
      pattern: '\\$\\{(?<body>[^}]*)\\}'
      unscanned_paths:
        - { path: "$.build", skip_keys: [], includes_subtree: true }
    function:
      definitions: [terraform, schema]
      call_result_reference_positions: [whole_scalar]
      calls_not_allowed_at:
        - { path: "$.*", skip_keys: [], includes_subtree: false }
        - { path: "$.cloud", skip_keys: [], includes_subtree: true }
      marker_function:
        call_marker: fn.
        splat_operator: '*'
        calls_without_name_allowed: true
    locals:
      scope_name: local
    key_orders:
      - { path: "$.locals", skip_keys: [], includes_subtree: false, order: alphabetical }
      - { path: "$.*", skip_keys: [locals], includes_subtree: false, order: significance }
      - { path: "$", skip_keys: [], includes_subtree: true, order: alphabetical }
    scopes:
      GLOBAL:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [env, 1]
      RESOURCE:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: true
        builtin_names: []
      local:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: []
      step:
        regions: []
        later_items_of_declaring_list: true
        named_by_parent_key: false
        builtin_names: []
    declarations:
      - path: "$.locals.*"
        skip_keys: []
        exclude_candidates: []
        name_source: key
        key_token: first_word
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: false
        scope_name: local
      - path: "$.*.*"
        skip_keys: [locals, 3]
        exclude_candidates: [defaults]
        name_source: key
        key_token: last_word
        name_spelling: dashes_as_underscores
        meta_argument_name: null
        declares_every_name: false
        scope_name: RESOURCE
      - path: "$.steps[*].*"
        skip_keys: []
        exclude_candidates: []
        name_source: meta_argument
        key_token: null
        name_spelling: as_written
        meta_argument_name: id
        declares_every_name: false
        scope_name: step
    references:
      - pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)'
        positions: [whole_scalar]
        text_after_name_allowed: true
        scope_name: RESOURCE
        scope_group: type
        name_group: name
      - pattern: '^local\\.(?<name>[a-z0-9_]+)$'
        positions: [whole_scalar, whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: local
        scope_group: null
        name_group: name
`;

test('a complete config states every field and keeps them', () => {
  const parsed = parseConfig(completeConfig);
  assert.equal(parsed.error, null);
  const [resources] = parsed.dsls;
  assert.deepEqual(resources.fileIncludes, ['**/mock.yml']);
  const keyOrderFields = (entry) => [entry.path, entry.skipKeys, entry.includesSubtree, entry.order];
  assert.deepEqual(resources.keyOrders.map(keyOrderFields), [
    ['$.locals', [], false, 'alphabetical'],
    ['$.*', ['locals'], false, 'significance'],
    ['$', [], true, 'alphabetical'],
  ]);
  assert.deepEqual(resources.fileExcludes, ['**/skip/**']);
  assert.deepEqual(resources.schemaSearchPaths, ['https://example.test/schema.json']);
  assert.deepEqual(resources.layers, {
    overlayFolders: ['one'],
    commonLayerDiscovery: 'ancestor',
    duplicateCheck: { depth: 3, keyDepths: { data_source: 2 }, skipKeys: ['schema_version'] },
  });
  assert.equal(resources.placeholder.pattern, '\\$\\{(?<body>[^}]*)\\}');
  assert.deepEqual(resources.placeholder.unscannedPaths, [
    { path: '$.build', tokens: [{ kind: 'key', key: 'build' }], skipKeys: [], includesSubtree: true },
  ]);
  assert.deepEqual(resources.function.definitions, ['terraform', 'schema']);
  assert.deepEqual(resources.function.callResultReferencePositions, ['whole_scalar']);
  assert.equal(resources.function.callsNotAllowedAt[1].includesSubtree, true);
  assert.deepEqual(resources.function.markerFunction, {
    callMarker: 'fn.',
    splatOperator: '*',
    callsWithoutNameAllowed: true,
  });
  assert.deepEqual(resources.locals, { scopeName: 'local' });
  assert.deepEqual(resources.scopes.GLOBAL, {
    regions: [[]],
    laterItemsOfDeclaringList: false,
    namedByParentKey: false,
    builtinNames: ['env'],
  });
  assert.equal(resources.scopes.RESOURCE.namedByParentKey, true);
  assert.deepEqual(resources.scopes.step.regions, []);
  assert.equal(resources.scopes.step.laterItemsOfDeclaringList, true);
  assert.deepEqual(resources.declarations.map((rule) => rule.nameSource), ['key', 'key', 'meta_argument']);
  assert.deepEqual(resources.declarations[1].skipKeys, ['locals']);
  assert.deepEqual(resources.declarations[1].excludeCandidates, ['defaults']);
  assert.equal(resources.declarations[1].keyToken, 'last_word');
  assert.equal(resources.declarations[1].nameSpelling, 'dashes_as_underscores');
  assert.equal(resources.declarations[2].metaArgumentName, 'id');
  assert.equal(resources.declarations[2].keyToken, null);
  assert.deepEqual(resources.references[0], {
    pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
    positions: ['whole_scalar'],
    textAfterNameAllowed: true,
    scopeName: 'RESOURCE',
    scopeGroup: 'type',
    nameGroup: 'name',
  });
  assert.equal(resources.references[1].textAfterNameAllowed, false);
});

test('a block the config leaves out is a feature the DSL does not have', () => {
  const parsed = parseConfig([
    'version: "1"',
    'dsls:',
    '  - id: flat',
    '    file_includes: ["**/flat.yml"]',
    '    file_excludes: []',
    '    schema_search_paths: []',
    '    key_orders: []',
    '    scopes: {}',
    '    declarations: []',
    '    references: []',
    '    function:',
    '      definitions: [schema]',
    '      call_result_reference_positions: []',
    '      calls_not_allowed_at: []',
    '',
  ].join('\n'));
  assert.equal(parsed.error, null);
  const [flat] = parsed.dsls;
  assert.equal(flat.layers, null);
  assert.equal(flat.placeholder, null);
  assert.equal(flat.locals, null);
  assert.equal(flat.function.markerFunction, null);
});

test('the duplicate check states its depth and the keys it passes over', () => {
  const layered = (id, duplicateCheck) => dslEntry(id, {
    layers: { overlay_folders: ['one'], common_layer_discovery: 'parent', duplicate_check: duplicateCheck },
  });
  const parsed = parseConfig(configText(
    layered('stated', { depth: 2, key_depths: { locals: 1 }, skip_keys: ['schema_version'] }),
    layered('shallow', { depth: 0, key_depths: { locals: 0 }, skip_keys: 1 }),
    layered('unmapped', { depth: 1, key_depths: 1, skip_keys: [] }),
  ));
  assert.deepEqual(parsed.dsls[0].layers.duplicateCheck, {
    depth: 2,
    keyDepths: { locals: 1 },
    skipKeys: ['schema_version'],
  });
  assert.equal(parsed.dsls[1].layers, null);
  assert.equal(parsed.dsls[2].layers, null);
  for (const message of [
    'shallow.layers.duplicate_check.depth is required: a whole number from 1',
    'shallow.layers.duplicate_check.key_depths.locals must be a whole number from 1',
    'shallow.layers.duplicate_check.skip_keys is required',
    'unmapped.layers.duplicate_check.key_depths is required: a mapping of keys to whole numbers from 1',
  ]) assert.ok(parsed.error.includes(message), message);
});

test('locals name a declared scope that a key declaration and a reference rule read', () => {
  const localsDsl = (id, fields) => dslEntry(id, {
    scopes: { local: scope(), step: scope() },
    declarations: [declaration('$.locals.*', 'local'), declaration('$.steps.*', 'step', { declares_every_name: true })],
    references: [reference('^local\\.(?<name>[a-z]+)$', 'local')],
    ...fields,
  });
  const parsed = parseConfig(configText(
    localsDsl('named', { locals: { scope_name: 'local' } }),
    localsDsl('mapless', { locals: 'local' }),
    localsDsl('nameless', { locals: {} }),
    localsDsl('undeclared', { locals: { scope_name: 'missing' } }),
    localsDsl('unread', { locals: { scope_name: 'step' } }),
  ));
  assert.deepEqual(parsed.dsls.map((dsl) => dsl.locals), [{ scopeName: 'local' }, null, null, null, null]);
  for (const message of [
    'mapless.locals must be a mapping with scope_name',
    'nameless.locals.scope_name is required',
    'undeclared.locals: scope missing is not declared in scopes',
    'unread.locals: no declaration rule reads step names from keys',
    'unread.locals: no reference rule reads step',
  ]) assert.ok(parsed.error.includes(message), message);
});

test('a config that leaves a field out is a problem, and the editor fills nothing in', () => {
  const parsed = parseConfig(`
version: "1"
dsls:
  - id: bare
    key_orders: [{ path: "$", skip_keys: [], includes_subtree: true, order: sideways }]
    layers: { overlay_folders: 1 }
    placeholder: { pattern: '(', unscanned_paths: [1, { path: bad }] }
    function:
      definitions: [elsewhere]
      call_result_reference_positions: [nowhere]
      calls_not_allowed_at: 1
      marker_function: { call_marker: "" }
    scopes:
      broken: 1
      lonely: { regions: [bad] }
      listed:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [mock]
      EMPTY:
        regions: []
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: []
      RESOURCE:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: true
        builtin_names: []
    declarations:
      - 1
      - { path: bad }
      - path: "$.a.*"
        skip_keys: []
        exclude_candidates: []
        name_source: key
        key_token: null
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: false
        scope_name: undeclared
      - path: "$.b.*"
        skip_keys: []
        exclude_candidates: []
        name_source: meta_argument
        key_token: null
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: false
        scope_name: listed
    references:
      - 1
      - pattern: '('
      - pattern: '^x'
        positions: [sideways]
        text_after_name_allowed: maybe
        scope_name: undeclared
        scope_group: 1
      - pattern: '^y'
        positions: [whole_scalar]
        text_after_name_allowed: false
        scope_name: RESOURCE
        scope_group: null
        name_group: name
      - pattern: '^z'
        positions: [whole_scalar]
        text_after_name_allowed: false
        scope_name: listed
        scope_group: group
        name_group: name
  - id: lists
    file_includes: 1
    file_excludes: 1
    schema_search_paths: 1
    key_orders: 1
    layers: 1
    placeholder: 1
    function: 1
    scopes: 1
    declarations: 1
    references: 1
  - { file_includes: ["**/*.yml"] }
`);
  assert.equal(parsed.ok, false);
  const expected = [
    'bare.file_includes is required',
    'bare.file_excludes is required',
    'bare.schema_search_paths is required',
    'bare.layers.overlay_folders is required',
    'bare.layers.common_layer_discovery is required: one of parent, ancestor',
    'bare.layers.duplicate_check is required: a mapping with depth, key_depths and skip_keys',
    'bare.placeholder.pattern is required',
    'bare.placeholder.unscanned_paths[0] must be a mapping',
    'bare.placeholder.unscanned_paths[1].path is required',
    'bare.placeholder.unscanned_paths[1].skip_keys is required',
    'bare.placeholder.unscanned_paths[1].includes_subtree is required',
    'bare.function.definitions is required: a list from terraform, schema',
    'bare.function.call_result_reference_positions is required',
    'bare.function.calls_not_allowed_at is required',
    'bare.function.marker_function.call_marker is required',
    'bare.function.marker_function.splat_operator is required',
    'bare.function.marker_function.calls_without_name_allowed is required',
    'bare.scopes.broken must be a mapping',
    'bare.scopes.lonely.regions is required',
    'bare.scopes.lonely.later_items_of_declaring_list is required',
    'bare.scopes.listed: builtin_names and named_by_parent_key are for a logical scope',
    'bare.scopes.EMPTY: a scope needs regions, or later_items_of_declaring_list',
    'bare.declarations[0] must be a mapping',
    'bare.declarations[1].path is required',
    'bare.declarations[1].name_source is required',
    'bare.declarations[2].key_token is required when name_source is key',
    'bare.declarations[2]: scope undeclared is not declared in scopes',
    'bare.declarations[3].meta_argument_name is required when name_source is meta_argument',
    'bare.references[0] must be a mapping',
    'bare.references[1].pattern is required',
    'bare.references[2].positions is required',
    'bare.references[2].text_after_name_allowed is required',
    'bare.references[2].scope_group is required',
    'bare.references[2].name_group is required',
    'bare.references[2]: scope undeclared is not declared in scopes',
    'bare.references[3].scope_group is required: RESOURCE is named by a parent key',
    'bare.references[4].scope_group must be null: listed is not named by a parent key',
    'lists.layers must be a mapping',
    'lists.placeholder must be a mapping',
    'lists.function must be a mapping',
    'lists.scopes is required',
    'lists.declarations is required',
    'lists.references is required',
    'lists.key_orders is required',
    'bare.key_orders[0].order is required: one of alphabetical, significance',
  ];
  for (const message of expected) assert.ok(parsed.error.includes(message), message);
  const [bare, lists] = parsed.dsls;
  assert.deepEqual(bare.declarations, []);
  assert.deepEqual(bare.references, []);
  assert.equal(bare.placeholder, null);
  assert.equal(bare.function, null);
  assert.deepEqual(lists.fileIncludes, []);
});

test('a config states its version, and only a version this extension reads is read', () => {
  const versionless = parseConfig('dsls: []\n');
  assert.equal(versionless.ok, false);
  assert.equal(versionless.error, 'yaml-dsl.yml version is required: one of "1"');
  assert.equal(parseConfig('version: 1\ndsls: []\n').ok, false);
  assert.equal(parseConfig('version: "2"\ndsls: []\n').ok, false);
  assert.deepEqual(parseConfig('version: "1"\ndsls: []\n'), { ok: true, error: null, dsls: [] });
  assert.deepEqual(parseConfig('version: "1"\n').dsls, []);
});

test('a config that is not a mapping is rejected', () => {
  assert.equal(parseConfig('- a\n- b\n').ok, false);
  assert.equal(parseConfig('key: [unclosed\n').ok, false);
});

test('file_includes and file_excludes decide the files a DSL owns, and two owners claim nothing', () => {
  const owner = (id, fileIncludes, fileExcludes = []) => ({ id, fileIncludes, fileExcludes });
  const suites = owner('suites', ['**/*.yml'], ['**/.github/**', '**/protocols/**']);
  assert.equal(ownsFile(suites, '/repo/games/slot-api.yml'), true);
  assert.equal(ownsFile(suites, '/repo/.github/workflows/test.yml'), false);
  assert.equal(ownsFile(suites, '/repo/protocols/mock/protocol.yml'), false);
  assert.equal(claimFile('/repo/protocols/mock/protocol.yml', [{ ...suites, dir: '/repo' }]).status, 'none');
  const claim = claimFile('/repo/mock.yml', [owner('a', ['**/*.yml']), owner('b', ['**/mock.yml'])]);
  assert.equal(claim.status, 'many');
  assert.deepEqual(claim.ids, ['a', 'b']);
  const shared = owner('resources', ['**/resources.yml']);
  const here = claimFile('/repo/a/resources.yml', [{ ...shared, dir: '/repo/a' }, { ...shared, dir: '/repo/b' }]);
  assert.equal(here.status, 'one');
  assert.equal(here.dsl.dir, '/repo/a');
  assert.equal(claimFile('/repo/c/resources.yml', [{ ...shared, dir: '/repo/a' }]).status, 'none');
  assert.equal(claimFile('/repo-a/resources.yml', [{ ...shared, dir: '/repo' }]).status, 'none');
  assert.equal(claimFile('/repo/a/resources.yml', [{ ...shared, dir: '/' }]).status, 'none');
  assert.equal(claimFile('/repo/readme.md', [{ ...shared, dir: '/repo' }]).status, 'none');
});

test('the shipped schema of the config states the values the reader accepts', () => {
  const shipped = require('../schemas/yaml-dsl.schema.json');
  const { definitions } = shipped;
  assert.deepEqual(shipped.properties.version.enum, CONFIG_VERSIONS);
  assert.deepEqual(definitions.layers.properties.common_layer_discovery.enum, COMMON_LAYER_DISCOVERIES);
  assert.deepEqual(definitions.function.properties.definitions.items.enum, FUNCTION_DEFINITIONS);
  assert.deepEqual(definitions.declaration.properties.name_source.enum, NAME_SOURCES);
  assert.deepEqual(definitions.declaration.properties.key_token.enum, [...KEY_TOKENS, null]);
  assert.deepEqual(definitions.declaration.properties.name_spelling.enum, NAME_SPELLINGS);
  assert.deepEqual(definitions.positions.items.enum, REFERENCE_POSITIONS);
  assert.deepEqual(definitions.key_order.properties.order.enum, KEY_ORDERS);
  assert.deepEqual(Object.keys(definitions.scopes.patternProperties), [LOGICAL_SCOPE_NAME.source]);
});

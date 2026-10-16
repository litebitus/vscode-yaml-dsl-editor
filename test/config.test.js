const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const {
  COMMON_LAYER_DISCOVERIES,
  CONFIG_VERSIONS,
  FUNCTION_DEFINITIONS,
  KEY_SORT_ORDERS,
  KEY_TOKENS,
  LOGICAL_SCOPE_NAME,
  NAME_SOURCES,
  NAME_SPELLINGS,
  parseConfig,
  claimFile,
  configPathOf,
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
  - id: sample
    file_includes: ["**/mock.yml", 1]
    file_excludes: ["**/skip/**"]
    schema_search_paths: [https://example.test/schema.json]
    layers:
      overlay_folders: [one, 2]
      common_layer_discovery: ancestor
      common_layer_files:
        mock.yml: ["{concern}.mock.yml", mock.yml]
      duplicate_check:
        depth: 3
        key_depths: { data_source: 2 }
        skip_keys: [schema_version]
    placeholder:
      pattern: '\\$\\{(?<body>[^}]*)\\}'
      unscanned_paths:
        - { path: "$.build", skip_keys: [] }
        - { path: "$.build..*", skip_keys: [] }
    function:
      definitions: [terraform, schema]
      call_result_reference_positions: [whole_scalar]
      calls_not_allowed_at:
        - { path: "$.*", skip_keys: [] }
        - { path: "$.cloud", skip_keys: [], includes_subtree: true }
      marker_function:
        call_marker: fn.
        splat_operator: '*'
        calls_without_name_allowed: true
    locals:
      scope_name: local
    validator:
      merge_base_keys: [defaults]
      child_values_from_parent_key:
        - pattern: '^(?<field>[a-z_]+) (?<value>[a-z0-9-]+)$'
    key_sort_orders:
      - path: "$.locals"
        skip_keys: []
        order: alphabetical
        first_keys: []
        last_keys: []
      - path: "$..*"
        skip_keys: [locals]
        order: significance
        first_keys: []
        last_keys: []
      - path: "$"
        skip_keys: []
        order: significance
        first_keys: [schema_version, locals]
        last_keys: [outputs]
    scopes:
      GLOBAL:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [env, 1]
      ENTRY:
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
        scope_name: ENTRY
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
        scope_name: ENTRY
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
  const [sample] = parsed.dsls;
  assert.deepEqual(sample.fileIncludes, ['**/mock.yml']);
  const keySortOrderFields = (entry) => [entry.path, entry.skipKeys, entry.order, entry.firstKeys, entry.lastKeys];
  assert.deepEqual(sample.keySortOrders.map(keySortOrderFields), [
    ['$.locals', [], 'alphabetical', [], []],
    ['$..*', ['locals'], 'significance', [], []],
    ['$', [], 'significance', ['schema_version', 'locals'], ['outputs']],
  ]);
  assert.deepEqual(sample.fileExcludes, ['**/skip/**']);
  assert.deepEqual(sample.schemaSearchPaths, ['https://example.test/schema.json']);
  assert.deepEqual(sample.layers, {
    overlayFolders: ['one'],
    commonLayerDiscovery: 'ancestor',
    commonLayerFiles: { 'mock.yml': ['{concern}.mock.yml', 'mock.yml'] },
    duplicateCheck: { depth: 3, keyDepths: { data_source: 2 }, skipKeys: ['schema_version'] },
  });
  assert.equal(sample.placeholder.pattern, '\\$\\{(?<body>[^}]*)\\}');
  assert.deepEqual(sample.placeholder.unscannedPaths, [
    { path: '$.build', tokens: [{ kind: 'name', key: 'build' }], skipKeys: [], includesSubtree: false },
    {
      path: '$.build..*',
      tokens: [{ kind: 'name', key: 'build' }, { kind: 'descendants' }],
      skipKeys: [],
      includesSubtree: false,
    },
  ]);
  assert.deepEqual(sample.function.definitions, ['terraform', 'schema']);
  assert.deepEqual(sample.function.callResultReferencePositions, ['whole_scalar']);
  assert.equal(sample.function.callsNotAllowedAt[1].includesSubtree, true);
  assert.deepEqual(sample.function.markerFunction, {
    callMarker: 'fn.',
    splatOperator: '*',
    callsWithoutNameAllowed: true,
  });
  assert.deepEqual(sample.locals, { scopeName: 'local' });
  assert.deepEqual(sample.validator, {
    mergeBaseKeys: ['defaults'],
    childValuesFromParentKey: [{ pattern: '^(?<field>[a-z_]+) (?<value>[a-z0-9-]+)$' }],
  });
  assert.deepEqual(sample.scopes.GLOBAL, {
    regions: [[]],
    laterItemsOfDeclaringList: false,
    namedByParentKey: false,
    builtinNames: ['env'],
  });
  assert.equal(sample.scopes.ENTRY.namedByParentKey, true);
  assert.deepEqual(sample.scopes.step.regions, []);
  assert.equal(sample.scopes.step.laterItemsOfDeclaringList, true);
  assert.deepEqual(sample.declarations.map((rule) => rule.nameSource), ['key', 'key', 'meta_argument']);
  assert.deepEqual(sample.declarations[1].skipKeys, ['locals']);
  assert.deepEqual(sample.declarations[1].excludeCandidates, ['defaults']);
  assert.equal(sample.declarations[1].keyToken, 'last_word');
  assert.equal(sample.declarations[1].nameSpelling, 'dashes_as_underscores');
  assert.equal(sample.declarations[2].metaArgumentName, 'id');
  assert.equal(sample.declarations[2].keyToken, null);
  assert.deepEqual(sample.references[0], {
    pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
    positions: ['whole_scalar'],
    textAfterNameAllowed: true,
    scopeName: 'ENTRY',
    scopeGroup: 'type',
    nameGroup: 'name',
  });
  assert.equal(sample.references[1].textAfterNameAllowed, false);
});

test('a block the config leaves out is a feature the DSL does not have', () => {
  const parsed = parseConfig([
    'version: "1"',
    'dsls:',
    '  - id: flat',
    '    file_includes: ["**/flat.yml"]',
    '    file_excludes: []',
    '    schema_search_paths: []',
    '    key_sort_orders: []',
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
  assert.equal(flat.validator, null);
  assert.equal(flat.function.markerFunction, null);
});

test('the validator block states its merge base keys and child value patterns, each pattern naming field and value', () => {
  const withValidator = (validatorLines) => parseConfig([
    'version: "1"',
    'dsls:',
    '  - id: mock',
    '    file_includes: ["**/mock.yml"]',
    '    file_excludes: []',
    '    schema_search_paths: []',
    '    key_sort_orders: []',
    '    scopes: {}',
    '    declarations: []',
    '    references: []',
    ...validatorLines.map((line) => `    ${line}`),
    '',
  ].join('\n'));
  assert.match(withValidator(['validator: []']).error, /mock\.validator must be a mapping/);
  assert.match(withValidator(['validator: {}']).error, /\.merge_base_keys is required/);
  assert.match(withValidator(['validator: {}']).error, /\.child_values_from_parent_key is required/);
  const unnamed = withValidator([
    'validator:',
    '  merge_base_keys: []',
    '  child_values_from_parent_key:',
    "    - pattern: '^(?<field>[a-z]+) (.+)$'",
    '    - pattern: "("',
    '    - mock',
  ]);
  assert.match(unnamed.error, /child_values_from_parent_key\[0\]\.pattern must name the child field and its value/);
  assert.match(unnamed.error, /child_values_from_parent_key\[1\]\.pattern is required/);
  assert.match(unnamed.error, /child_values_from_parent_key\[2\] must be a mapping with pattern/);
  assert.deepEqual(unnamed.dsls[0].validator, { mergeBaseKeys: [], childValuesFromParentKey: [] });
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

test('common layer files list the names a common layer may take, each a file name, one without {concern}', () => {
  const layered = (id, discovery, commonLayerFiles) => dslEntry(id, {
    layers: {
      overlay_folders: ['one'],
      common_layer_discovery: discovery,
      common_layer_files: commonLayerFiles,
      duplicate_check: { depth: 1, key_depths: {}, skip_keys: [] },
    },
  });
  const parsed = parseConfig(configText(
    layered('stated', 'ancestor', { 'mock.yml': ['{concern}.mock.yml', 'mock.yml'] }),
    layered('unmapped', 'ancestor', ['mock.yml']),
    layered('empty', 'ancestor', { 'mock.yml': [] }),
    layered('pathed', 'ancestor', { 'mock.yml': ['nested/mock.yml'] }),
    layered('twice', 'ancestor', { 'mock.yml': ['mock.yml', 'mock.yml'] }),
    layered('doubled', 'ancestor', { 'mock.yml': ['{concern}.{concern}.yml', 'mock.yml'] }),
    layered('concerned', 'ancestor', { 'mock.yml': ['{concern}.mock.yml'] }),
    layered('parented', 'parent', { 'mock.yml': ['{concern}.mock.yml', 'mock.yml'] }),
    layered('keyed', 'ancestor', { '..': ['mock.yml'] }),
  ));
  assert.deepEqual(parsed.dsls[0].layers.commonLayerFiles, { 'mock.yml': ['{concern}.mock.yml', 'mock.yml'] });
  assert.ok(parsed.dsls.slice(1).every((dsl) => dsl.layers === null));
  for (const message of [
    'unmapped.layers.common_layer_files must be a mapping of a layer file name to the names its common layer may take',
    'empty.layers.common_layer_files.mock.yml is required: a list of file names, the first tried first',
    'pathed.layers.common_layer_files.mock.yml is required: a list of file names',
    'twice.layers.common_layer_files.mock.yml lists a name more than once',
    'doubled.layers.common_layer_files.mock.yml holds {concern} more than once in a name',
    'concerned.layers.common_layer_files.mock.yml holds no name without {concern}',
    'parented.layers.common_layer_files.mock.yml names a {concern} common layer, which only '
      + 'common_layer_discovery: ancestor reaches',
    'keyed.layers.common_layer_files... is keyed by a layer file name',
  ]) assert.ok(parsed.error.includes(message), message);
  const unstated = parseConfig(configText(dslEntry('unstated', {
    layers: {
      overlay_folders: ['one'],
      common_layer_discovery: 'ancestor',
      duplicate_check: { depth: 1, key_depths: {}, skip_keys: [] },
    },
  })));
  assert.deepEqual(unstated.dsls[0].layers.commonLayerFiles, {});
});

test('a concern common layer belongs to its DSL whatever file_includes says, and file_excludes still applies', () => {
  const layered = {
    id: 'layered',
    fileIncludes: ['**/mock.yml'],
    fileExcludes: ['**/skip/**'],
    layers: { commonLayerFiles: { 'mock.yml': ['{concern}.mock.yml', 'mock-common.yml', 'mock.yml'] } },
  };
  assert.equal(ownsFile(layered, '/repo/mock-stack/config.mock.yml'), true);
  assert.equal(ownsFile(layered, '/repo/skip/config.mock.yml'), false);
  assert.equal(ownsFile(layered, '/repo/mock-stack/mock-common.yml'), false);
  assert.equal(ownsFile(layered, '/repo/mock-stack/other.yml'), false);
  assert.equal(ownsFile({ ...layered, layers: null }, '/repo/mock-stack/config.mock.yml'), false);
});

test('a path is a JSONPath listed once per list; ..* ends it, and includes_subtree is read only where it shipped', () => {
  const pathEntries = (id, unscannedPaths, keySortOrders) => dslEntry(id, {
    placeholder: { pattern: '\\$\\{(?<body>[^}]*)\\}', unscanned_paths: unscannedPaths },
    key_sort_orders: keySortOrders,
  });
  const sortEntry = (fields) => ({ path: '$', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [], ...fields });
  const parsed = parseConfig(configText(
    pathEntries('listed', [
      { path: '$.build', skip_keys: [] },
      { path: '$.build..*', skip_keys: [] },
      { path: '$.cloud', skip_keys: [], includes_subtree: true },
    ], [sortEntry({})]),
    pathEntries('twice', [{ path: '$.build', skip_keys: [] }, { path: '$.build', skip_keys: [] }], []),
    pathEntries('inner', [{ path: '$..*.name', skip_keys: [] }], []),
    pathEntries('retired', [], [sortEntry({ includes_subtree: true })]),
  ));
  const [listed] = parsed.dsls;
  assert.deepEqual(listed.placeholder.unscannedPaths.map((entry) => [entry.path, entry.includesSubtree]), [
    ['$.build', false],
    ['$.build..*', false],
    ['$.cloud', true],
  ]);
  for (const message of [
    'twice.placeholder.unscanned_paths[1].path $.build is listed more than once in unscanned_paths',
    'inner.placeholder.unscanned_paths[0].path is required: a JSONPath such as $.build or $.build..*',
    'retired.key_sort_orders[0].includes_subtree is not read here: list the path ending in ..* as its own entry',
  ]) assert.ok(parsed.error.includes(message), message);
});

test('first_keys and last_keys are distinct keys, apart from each other, and [] under alphabetical', () => {
  const ordered = (id, order, firstKeys, lastKeys) => dslEntry(id, {
    key_sort_orders: [{
      path: '$',
      skip_keys: [],
      order,
      first_keys: firstKeys,
      last_keys: lastKeys,
    }],
  });
  const parsed = parseConfig(configText(
    ordered('ranked', 'significance', ['env'], ['outputs']),
    ordered('sorted', 'alphabetical', ['env'], []),
    ordered('both', 'significance', ['env', 'outputs'], ['outputs']),
    ordered('repeated', 'significance', ['env', 'env'], []),
    ordered('unnamed', 'significance', ['env', ''], [1]),
  ));
  const firstAndLastKeys = (entry) => [entry.firstKeys, entry.lastKeys];
  assert.deepEqual(parsed.dsls[0].keySortOrders.map(firstAndLastKeys), [[['env'], ['outputs']]]);
  for (const dsl of parsed.dsls.slice(1)) assert.deepEqual(dsl.keySortOrders, []);
  for (const message of [
    'sorted.key_sort_orders[0] lists first_keys or last_keys under alphabetical order; both are [] there',
    'both.key_sort_orders[0] lists outputs in both first_keys and last_keys',
    'repeated.key_sort_orders[0].first_keys lists a key more than once',
    'unnamed.key_sort_orders[0].first_keys is required: a list of keys, [] when empty',
    'unnamed.key_sort_orders[0].last_keys is required: a list of keys, [] when empty',
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
    key_sort_orders: [{ path: "$", skip_keys: [], order: sideways }]
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
      ENTRY:
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
        scope_name: ENTRY
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
    key_sort_orders: 1
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
    'bare.references[3].scope_group is required: ENTRY is named by a parent key',
    'bare.references[4].scope_group must be null: listed is not named by a parent key',
    'lists.layers must be a mapping',
    'lists.placeholder must be a mapping',
    'lists.function must be a mapping',
    'lists.scopes is required',
    'lists.declarations is required',
    'lists.references is required',
    'lists.key_sort_orders is required',
    'bare.key_sort_orders[0].order is required: one of alphabetical, significance',
    'bare.key_sort_orders[0].first_keys is required: a list, [] when empty',
    'bare.key_sort_orders[0].last_keys is required: a list, [] when empty',
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
  const shared = owner('sample', ['**/sample.yml']);
  const here = claimFile('/repo/a/sample.yml', [{ ...shared, dir: '/repo/a' }, { ...shared, dir: '/repo/b' }]);
  assert.equal(here.status, 'one');
  assert.equal(here.dsl.dir, '/repo/a');
  assert.equal(claimFile('/repo/c/sample.yml', [{ ...shared, dir: '/repo/a' }]).status, 'none');
  assert.equal(claimFile('/repo-a/sample.yml', [{ ...shared, dir: '/repo' }]).status, 'none');
  assert.equal(claimFile('/repo/a/sample.yml', [{ ...shared, dir: '/' }]).status, 'none');
  assert.equal(claimFile('/repo/readme.md', [{ ...shared, dir: '/repo' }]).status, 'none');
});

test('the deepest config folder owns a file, and its yaml-dsl.yml is never a DSL file', () => {
  const owner = (id, dir, fileIncludes) => ({ id, dir, fileIncludes, fileExcludes: [] });
  const outer = owner('outer', '/repo', ['**/*.yaml', '**/*.yml']);
  const inner = owner('inner', '/repo/examples/cfn', ['{config_root}/**/*.yaml']);
  const deep = claimFile('/repo/examples/cfn/sqs/queue.yaml', [outer, inner]);
  assert.equal(deep.status, 'one');
  assert.equal(deep.dsl.id, 'inner');
  assert.equal(claimFile('/repo/examples/cfn/notes.yml', [outer, inner]).status, 'none');
  assert.equal(claimFile('/repo/examples/other.yaml', [outer, inner]).dsl.id, 'outer');
  assert.equal(claimFile('/repo/examples/cfn/yaml-dsl.yml', [outer, inner]).status, 'none');
  assert.equal(claimFile('/repo/yaml-dsl.yml', [outer]).status, 'none');
});

test('a glob starting with {config_root} matches below the config folder, and every other glob keeps its meaning', () => {
  const dsl = { id: 'mock', dir: '/repo/mock', fileIncludes: ['{config_root}/*.yaml'], fileExcludes: ['{config_root}/skip.yaml'] };
  assert.equal(ownsFile(dsl, '/repo/mock/a.yaml'), true);
  assert.equal(ownsFile(dsl, '/repo/mock/nested/a.yaml'), false);
  assert.equal(ownsFile(dsl, '/repo/mock/skip.yaml'), false);
  assert.equal(ownsFile(dsl, '/repo/mock-other/a.yaml'), false);
  const anyDepth = { id: 'mock', dir: '/repo/mock', fileIncludes: ['**/mock/*.yaml'], fileExcludes: [] };
  assert.equal(ownsFile(anyDepth, '/repo/mock/a.yaml'), true);
  const relative = { id: 'mock', dir: '/repo/mock', fileIncludes: ['*.yaml'], fileExcludes: [] };
  assert.equal(ownsFile(relative, '/repo/mock/a.yaml'), false);
  assert.equal(configPathOf('{config_root}/../schemas/mock.schema.json', '/repo/mock'), '/repo/schemas/mock.schema.json');
  assert.equal(configPathOf('schemas/mock.schema.json', '/repo/mock'), 'schemas/mock.schema.json');
});

test('the shipped schema of the config is a draft 2020-12 schema stating the values the reader accepts', () => {
  const shipped = require('../schemas/yaml-dsl.schema.json');
  assert.equal(shipped.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.doesNotThrow(() => new Ajv2020({ strict: false, strictSchema: true }).compile(shipped));
  const definitions = shipped.$defs;
  assert.deepEqual(shipped.properties.version.enum, CONFIG_VERSIONS);
  assert.deepEqual(definitions.layers.properties.common_layer_discovery.enum, COMMON_LAYER_DISCOVERIES);
  assert.deepEqual(definitions.function.properties.definitions.items.enum, FUNCTION_DEFINITIONS);
  assert.deepEqual(definitions.declaration.properties.name_source.enum, NAME_SOURCES);
  assert.deepEqual(definitions.declaration.properties.key_token.enum, [...KEY_TOKENS, null]);
  assert.deepEqual(definitions.declaration.properties.name_spelling.enum, NAME_SPELLINGS);
  assert.deepEqual(definitions.positions.items.enum, REFERENCE_POSITIONS);
  assert.deepEqual(definitions.key_sort_order.properties.order.enum, KEY_SORT_ORDERS);
  assert.deepEqual(Object.keys(definitions.scopes.patternProperties), [LOGICAL_SCOPE_NAME.source]);
});

test('tag_keys pairs each tag with the key it stands for, and a DSL without reads none', () => {
  const tagged = parseConfig(configText(dslEntry('sample', {
    tag_keys: [{ tag: '!Ref', key: 'Ref' }, { tag: '!GetAtt', key: 'Fn::GetAtt' }],
  })));
  assert.equal(tagged.ok, true);
  assert.deepEqual(tagged.dsls[0].tagKeys, [{ tag: '!Ref', key: 'Ref' }, { tag: '!GetAtt', key: 'Fn::GetAtt' }]);
  assert.deepEqual(parseConfig(configText(dslEntry('sample'))).dsls[0].tagKeys, []);
  const problemsOf = (tagKeys) => parseConfig(configText(dslEntry('sample', { tag_keys: tagKeys }))).error;
  assert.equal(problemsOf('!Ref'), 'sample.tag_keys must be a list of tag and key pairs');
  assert.equal(problemsOf(['!Ref']), 'sample.tag_keys[0] must be a mapping with tag and key');
  assert.equal(
    problemsOf([{ tag: 'Ref', key: 'Ref' }]),
    'sample.tag_keys[0].tag is required: a YAML tag as written, such as !Ref',
  );
  assert.equal(
    problemsOf([{ tag: '!Ref' }]),
    'sample.tag_keys[0].key is required: the key the tagged node stands for',
  );
  assert.equal(
    problemsOf([{ tag: '!Ref', key: 'Ref' }, { tag: '!Ref', key: 'Other' }]),
    'sample.tag_keys[1].tag !Ref is listed more than once',
  );
  assert.equal(
    problemsOf([{ tag: '!Ref', key: 'Ref' }, { tag: '!Other', key: 'Ref' }]),
    'sample.tag_keys[1].key Ref is listed more than once',
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIG_VERSIONS,
  parseConfig,
  createConfigReader,
  claimFile,
  configPathOf,
  ownsFile,
} = require('../lib/config');
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
    file_includes: ["**/mock.yml"]
    file_excludes: ["**/skip/**"]
    schema_search_paths: [https://example.test/schema.json]
    layers:
      overlay_folders: [one]
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
    performance:
      compiled_schema_cache: true
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
        builtin_names: [env]
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
        skip_keys: [locals]
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

function withFields(fields) {
  return parseConfig(configText(dslEntry('mock', fields)));
}

test('a complete config states every field and keeps them', () => {
  const parsed = parseConfig(completeConfig);
  assert.deepEqual(parsed.problems, []);
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
    overlayIncludes: [],
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
  assert.deepEqual(sample.locals, { scopeName: 'local', pathSeparator: null });
  assert.deepEqual(sample.validator, {
    mergeBaseKeys: ['defaults'],
    childValuesFromParentKey: [{ pattern: '^(?<field>[a-z_]+) (?<value>[a-z0-9-]+)$' }],
    allowQuotedValues: [],
  });
  assert.deepEqual(sample.performance, { compiledSchemaCache: true });
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
  const parsed = withFields({
    function: { definitions: ['schema'], call_result_reference_positions: [], calls_not_allowed_at: [] },
  });
  assert.deepEqual(parsed.problems, []);
  const [flat] = parsed.dsls;
  assert.equal(flat.layers, null);
  assert.equal(flat.placeholder, null);
  assert.equal(flat.locals, null);
  assert.equal(flat.loops, null);
  assert.equal(flat.validator, null);
  assert.deepEqual(flat.tagKeys, []);
  assert.deepEqual(flat.performance, { compiledSchemaCache: false });
  assert.equal(flat.function.markerFunction, null);
});

test('the performance block states whether the compiled schema is kept', () => {
  assert.deepEqual(withFields({ performance: { compiled_schema_cache: true } }).dsls[0].performance, {
    compiledSchemaCache: true,
  });
  assert.deepEqual(withFields({ performance: { compiled_schema_cache: false } }).dsls[0].performance, {
    compiledSchemaCache: false,
  });
});

test('the validator block states its merge base keys, child value patterns and quoted value types', () => {
  const pattern = '^(?<field>[a-z]+) (?<value>.+)$';
  const listed = withFields({
    validator: {
      merge_base_keys: ['defaults'],
      child_values_from_parent_key: [{ pattern }],
      allow_quoted_values: ['boolean', 'integer', 'number'],
    },
  });
  assert.deepEqual(listed.dsls[0].validator, {
    mergeBaseKeys: ['defaults'],
    childValuesFromParentKey: [{ pattern }],
    allowQuotedValues: ['boolean', 'integer', 'number'],
  });
  const bare = withFields({ validator: { child_values_from_parent_key: [] } });
  assert.deepEqual(bare.dsls[0].validator, { mergeBaseKeys: [], childValuesFromParentKey: [], allowQuotedValues: [] });
});

test('layers state their overlay folders, discovery and duplicate check, and no common layer files when left out', () => {
  const layers = {
    overlay_folders: ['one'],
    common_layer_discovery: 'parent',
    duplicate_check: { depth: 2, key_depths: { locals: 1 }, skip_keys: ['schema_version'] },
  };
  const [dsl] = withFields({ layers }).dsls;
  assert.deepEqual(dsl.layers, {
    overlayFolders: ['one'],
    commonLayerDiscovery: 'parent',
    commonLayerFiles: {},
    overlayIncludes: [],
    duplicateCheck: { depth: 2, keyDepths: { locals: 1 }, skipKeys: ['schema_version'] },
  });
});

test('path entries keep their path, its steps, their skipped keys and includes_subtree', () => {
  const [dsl] = withFields({
    placeholder: {
      pattern: '\\$\\{(?<body>[^}]*)\\}',
      escape_prefix: '$',
      unscanned_paths: [
        { path: '$.build', skip_keys: ['local'] },
        { path: '$.cloud', skip_keys: [], includes_subtree: true },
      ],
    },
  }).dsls;
  assert.equal(dsl.placeholder.escapePrefix, '$');
  assert.deepEqual(dsl.placeholder.unscannedPaths, [
    { path: '$.build', tokens: [{ kind: 'name', key: 'build' }], skipKeys: ['local'], includesSubtree: false },
    { path: '$.cloud', tokens: [{ kind: 'name', key: 'cloud' }], skipKeys: [], includesSubtree: true },
  ]);
});

test('locals and loops name their scopes, and locals may state a path separator', () => {
  const [dsl] = withFields({
    scopes: { local: scope(), item: scope() },
    declarations: [declaration('$.locals.*', 'local')],
    references: [reference('^local\\.(?<name>[a-z]+)$', 'local'), reference('^(?<name>it)$', 'item')],
    locals: { scope_name: 'local', path_separator: '.' },
    loops: { scope_name: 'item' },
  }).dsls;
  assert.deepEqual(dsl.locals, { scopeName: 'local', pathSeparator: '.' });
  assert.deepEqual(dsl.loops, { scopeName: 'item' });
});

test('tag_keys pairs each tag with the key it stands for, and a DSL without reads none', () => {
  const tagged = withFields({ tag_keys: [{ tag: '!Ref', key: 'Ref' }, { tag: '!GetAtt', key: 'Fn::GetAtt' }] });
  assert.deepEqual(tagged.dsls[0].tagKeys, [{ tag: '!Ref', key: 'Ref' }, { tag: '!GetAtt', key: 'Fn::GetAtt' }]);
  assert.deepEqual(withFields({}).dsls[0].tagKeys, []);
});

test('overlay_includes pairs an overlay with the common layers its includes name, and reads no overlay folders', () => {
  const layers = {
    common_layer_discovery: 'overlay_includes',
    overlay_includes: [{
      key_paths: ['$.Include', "$..['Mock::Include']"],
      value_conditions: [{ key: 'Name', value: 'Mock::Snippet' }],
      location_path: '$.Parameters.Location',
      location_mappings: [{ local: '{config_root}/snippets/', remote: 's3://mock-bucket/snippets/' }],
    }],
    duplicate_check: { depth: 2, key_depths: {}, skip_keys: [] },
  };
  const parsed = withFields({ layers });
  assert.deepEqual(parsed.problems, []);
  const [include] = parsed.dsls[0].layers.overlayIncludes;
  assert.equal(parsed.dsls[0].layers.commonLayerDiscovery, 'overlay_includes');
  assert.deepEqual(parsed.dsls[0].layers.overlayFolders, []);
  assert.deepEqual(include.keyPaths, [
    [{ kind: 'name', key: 'Include' }],
    [{ kind: 'descendant_name', key: 'Mock::Include' }],
  ]);
  assert.deepEqual(include.valueConditions, [{ key: 'Name', value: 'Mock::Snippet' }]);
  assert.deepEqual(include.locationPath, [{ kind: 'name', key: 'Parameters' }, { kind: 'name', key: 'Location' }]);
  assert.deepEqual(include.locationMappings, [
    { local: '{config_root}/snippets/', remote: 's3://mock-bucket/snippets/' },
  ]);
});

test('a config is read by the YAML DSL standard, each problem a diagnostic at its field, and no DSL read', () => {
  const misspelt = configText(dslEntry('mock')).replace('file_excludes', 'file_exclude');
  const parsed = parseConfig(misspelt, '/repo/yaml-dsl.yml');
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.dsls, []);
  const placed = parsed.problems.map((problem) => [
    problem.position.line,
    problem.position.column,
    problem.message,
    problem.notes.help,
  ]);
  assert.deepEqual(placed, [
    [3, 5, 'field `file_excludes` is required', null],
    [6, 5, 'field `file_exclude` is not allowed', 'did you mean `file_excludes`?'],
  ]);
  assert.equal(parsed.problems[0].position.file, '/repo/yaml-dsl.yml');
});

test('a config states its version, and only a version the standard reads is read', () => {
  assert.deepEqual(CONFIG_VERSIONS, ['1', '1.0', '1.1']);
  for (const version of CONFIG_VERSIONS) {
    assert.deepEqual(parseConfig(`version: "${version}"\ndsls: []\n`), { ok: true, problems: [], dsls: [] });
  }
  const versionless = parseConfig('dsls: []\n');
  assert.equal(versionless.ok, false);
  assert.equal(versionless.problems[0].message, 'field `version` is required');
  assert.equal(parseConfig('version: 1\ndsls: []\n').ok, false);
  assert.equal(parseConfig('version: "2"\ndsls: []\n').ok, false);
});

test('a config that is not a mapping, or not YAML, is rejected', () => {
  assert.equal(parseConfig('- a\n- b\n').ok, false);
  assert.equal(parseConfig('key: [unclosed\n').ok, false);
});

test('a folder keeps the DSLs its config last read cleanly while the config holds problems', () => {
  const readConfig = createConfigReader();
  const clean = configText(dslEntry('mock'));
  const broken = clean.replace('file_excludes', 'file_exclude');
  const first = readConfig('/repo/a', broken);
  assert.deepEqual([first.ok, first.dsls], [false, []]);
  assert.equal(readConfig('/repo/a', clean).dsls[0].id, 'mock');
  const editing = readConfig('/repo/a', broken);
  assert.equal(editing.ok, false);
  assert.ok(editing.problems.length > 0);
  assert.deepEqual(editing.dsls.map((dsl) => dsl.id), ['mock']);
  assert.deepEqual(readConfig('/repo/b', broken).dsls, []);
  const renamed = configText(dslEntry('renamed'));
  assert.deepEqual(readConfig('/repo/a', renamed).dsls.map((dsl) => dsl.id), ['renamed']);
  assert.deepEqual(readConfig('/repo/a', broken).dsls.map((dsl) => dsl.id), ['renamed']);
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

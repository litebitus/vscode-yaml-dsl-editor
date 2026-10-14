const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');
const { createNodeIds } = require('../lib/node-ids');
const {
  commonLayerSuggestions,
  combinedMoveEdits,
  editedTexts,
  foldsAgreeAfter,
  localReferenceText,
} = require('../lib/common-layer-suggestions');
const { createSchemaChecks } = require('../lib/schema-checks');
const {
  scope,
  declaration,
  reference,
  placeholder,
  dslEntry,
  parsedDsl,
  markerFunction,
} = require('./config-builders');

const OVERLAYS = ['dev', 'staging', 'uat', 'production'];
const common = '/repo/mock.yml';
const overlayPath = (name) => `/repo/${name}/mock.yml`;
const noSchemaChecks = createSchemaChecks(() => null);

const resourceKeySortOrders = [
  { path: '$.locals', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
  { path: '$..*', skip_keys: ['locals'], order: 'significance', first_keys: [], last_keys: [] },
  {
    path: '$',
    skip_keys: [],
    order: 'significance',
    first_keys: ['schema_version', 'env', 'locals'],
    last_keys: ['data_source', 'outputs'],
  },
];

function unitLayers(depth, keyDepths = { data_source: 2, locals: 2 }) {
  return {
    overlay_folders: OVERLAYS,
    common_layer_discovery: 'ancestor',
    duplicate_check: { depth, key_depths: keyDepths, skip_keys: ['schema_version'] },
  };
}

function layeredDsl(fields = {}, localPositions = ['whole_scalar', 'whole_placeholder', 'placeholder_in_text']) {
  return parsedDsl(dslEntry('resource', {
    layers: unitLayers(3),
    key_sort_orders: resourceKeySortOrders,
    placeholder: placeholder(),
    locals: { scope_name: 'local' },
    scopes: { local: scope(), RESOURCE: scope({ named_by_parent_key: true }) },
    declarations: [
      declaration('$.locals.*', 'local', { key_token: 'first_word' }),
      declaration('$.*.*', 'RESOURCE', { skip_keys: ['locals'], key_token: 'last_word' }),
    ],
    references: [reference('^local\\.(?<name>[a-z0-9_]+)$', 'local', { positions: localPositions })],
    ...fields,
  }));
}

function stackOf(dsl, texts) {
  const nodeIds = createNodeIds();
  const files = new Map();
  for (const [filePath, text] of Object.entries(texts)) {
    files.set(filePath, analyzeDocument(text, filePath, dsl, nodeIds));
  }
  return {
    dsl,
    files,
    common,
    overlays: Object.fromEntries(OVERLAYS.map((name) => [name, overlayPath(name)])),
    symbols: [...files.values()].flatMap((doc) => doc.symbols),
  };
}

function texts(commonText, overlayTexts) {
  const out = { [common]: commonText };
  for (const [name, text] of Object.entries(overlayTexts)) out[overlayPath(name)] = text;
  return out;
}

test('a block every overlay holds with one difference is a move writing the difference as a local', () => {
  const eventsText = 'queue:\n  events:\n    retention_seconds: 86400\n    max_receive_count: 5\n';
  const stack = stackOf(layeredDsl({ layers: unitLayers(1) }), texts('locals:\n  team: mock-team\n', {
    dev: eventsText,
    staging: 'queue:\n  events:\n    retention_seconds: 86400  # same\n    max_receive_count: 5\n',
    uat: eventsText,
    production: 'locals:\n  zone: mock-zone\nqueue:\n  events: { retention_seconds: 1209600, max_receive_count: 5 }\n',
  }));
  const [suggestion, ...rest] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.equal(rest.length, 0);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.path, ['queue']);
  assert.deepEqual(suggestion.holders, ['dev', 'staging', 'uat', 'production']);
  assert.deepEqual(suggestion.absent, []);
  assert.deepEqual(suggestion.differencePaths, [['queue', 'events', 'retention_seconds']]);
  assert.deepEqual(suggestion.differences, [{
    name: 'queue_retention_seconds',
    referenceText: 'local.queue_retention_seconds',
    values: [{ text: '86400', overlays: ['dev', 'staging', 'uat'] }, { text: '1209600', overlays: ['production'] }],
  }]);
  assert.deepEqual(suggestion.marks.map((mark) => [mark.file, mark.range.start]), [
    [overlayPath('dev'), { line: 0, character: 6 }],
    [overlayPath('staging'), { line: 0, character: 6 }],
    [overlayPath('uat'), { line: 0, character: 6 }],
    [overlayPath('production'), { line: 2, character: 6 }],
  ]);
  const edited = editedTexts(stack, suggestion);
  assert.equal(edited.get(common), [
    'locals:',
    '  queue_retention_seconds: 86400',
    '  team: mock-team',
    'queue:',
    '  events:',
    '    retention_seconds: local.queue_retention_seconds',
    '    max_receive_count: 5',
    '',
  ].join('\n'));
  assert.equal(edited.get(overlayPath('dev')), '');
  assert.equal(edited.get(overlayPath('uat')), '');
  assert.equal(
    edited.get(overlayPath('production')),
    'locals:\n  queue_retention_seconds: 1209600\n  zone: mock-zone\n',
  );
  assert.equal(foldsAgreeAfter(stack, suggestion, edited), true);
  const changedCount = edited.get(common).replace('max_receive_count: 5', 'max_receive_count: 6');
  const tampered = new Map(edited).set(common, changedCount);
  assert.equal(foldsAgreeAfter(stack, suggestion, tampered), false);
});

function neighborBlocksText(name, between = '') {
  return [
    'service:',
    '  main:',
    '    alpha:',
    '      size: 1',
    ...(between ? [`    ${between}: ${name}`] : []),
    '    beta:',
    '      size: 2',
    '    gamma:',
    '      size: 3',
    '',
  ].join('\n');
}

test('neighboring moves in one map combine into one move, its scope every line they take', () => {
  const overlayTexts = Object.fromEntries(OVERLAYS.map((name) => [name, neighborBlocksText(name)]));
  const stack = stackOf(layeredDsl(), texts('service:\n  main:\n    kept: mock-kept\n', overlayTexts));
  const [suggestion, ...rest] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.equal(rest.length, 0);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.memberPaths, [
    ['service', 'main', 'alpha'],
    ['service', 'main', 'beta'],
    ['service', 'main', 'gamma'],
  ]);
  assert.deepEqual(suggestion.marks.map((mark) => [mark.range.start.line, mark.scope.start.line, mark.scope.end.line]), [
    [2, 2, 7],
    [2, 2, 7],
    [2, 2, 7],
    [2, 2, 7],
  ]);
});

test('a key between two moves keeps them two moves', () => {
  const overlayTexts = Object.fromEntries(OVERLAYS.map((name) => [name, neighborBlocksText(name, 'owner')]));
  const stack = stackOf(layeredDsl(), texts('service:\n  main:\n    kept: mock-kept\n', overlayTexts));
  const moves = commonLayerSuggestions(stack, noSchemaChecks).filter((suggestion) => suggestion.kind === 'move');
  assert.deepEqual(moves.map((suggestion) => [suggestion.path.join('.'), suggestion.memberPaths]), [
    ['service.main.alpha', undefined],
    ['service.main.beta', [['service', 'main', 'beta'], ['service', 'main', 'gamma']]],
  ]);
});

test('a combined move writes its blocks into the common layer in the overlays\' order', () => {
  const overlayTexts = Object.fromEntries(OVERLAYS.map((name) => [name, neighborBlocksText(name)]));
  const stack = stackOf(layeredDsl(), texts('service:\n  main:\n    kept: mock-kept\n', overlayTexts));
  const [suggestion] = commonLayerSuggestions(stack, noSchemaChecks);
  const edited = editedTexts(stack, { edits: combinedMoveEdits(stack, suggestion, noSchemaChecks) });
  assert.equal(edited.get(common), [
    'service:',
    '  main:',
    '    kept: mock-kept',
    '    alpha:',
    '      size: 1',
    '    beta:',
    '      size: 2',
    '    gamma:',
    '      size: 3',
    '',
  ].join('\n'));
  for (const name of OVERLAYS) assert.doesNotMatch(edited.get(overlayPath(name)), /alpha|beta|gamma/);
});

test('neighboring values and blocks under a map the common layer lacks move as one, in the overlays\' order', () => {
  const holder = (name) => [
    'workload:',
    '  app:',
    '    kind: mock-kind',
    '    image: mock-image',
    '',
    '    probe:',
    '      port: 1',
    '',
    '    reach:',
    `      ${name}: 1`,
    '',
  ].join('\n');
  const overlayTexts = Object.fromEntries(OVERLAYS.map((name) => [name, holder(name)]));
  const stack = stackOf(layeredDsl(), texts('schema_version: "3"\n', overlayTexts));
  const [suggestion, ...rest] = commonLayerSuggestions(stack, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.equal(rest.length, 0);
  assert.deepEqual(suggestion.memberPaths, [
    ['workload', 'app', 'kind'],
    ['workload', 'app', 'image'],
    ['workload', 'app', 'probe'],
  ]);
  const edited = editedTexts(stack, { edits: combinedMoveEdits(stack, suggestion, noSchemaChecks) });
  assert.equal(edited.get(common), [
    'schema_version: "3"',
    'workload:',
    '  app:',
    '    kind: mock-kind',
    '    image: mock-image',
    '',
    '    probe:',
    '      port: 1',
    '',
  ].join('\n'));
  for (const name of OVERLAYS) {
    assert.equal(edited.get(overlayPath(name)), `workload:\n  app:\n    reach:\n      ${name}: 1\n`);
  }
});

test('a difference whose values tie is declared in each overlay, the common layer holding the empty value of its type', () => {
  const holder = (retention) => `queue:\n  events:\n    retention_seconds: ${retention}\n    max_receive_count: 5\n`;
  const stack = stackOf(layeredDsl({ layers: unitLayers(1) }), texts('locals:\n  team: mock-team\n', {
    dev: holder(86400),
    staging: holder(86400),
    uat: holder(1209600),
    production: holder(1209600),
  }));
  const [suggestion] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.equal(suggestion.kind, 'move');
  const edited = editedTexts(stack, suggestion);
  assert.equal(edited.get(common), [
    'locals:',
    '  queue_retention_seconds: 0',
    '  team: mock-team',
    'queue:',
    '  events:',
    '    retention_seconds: local.queue_retention_seconds',
    '    max_receive_count: 5',
    '',
  ].join('\n'));
  assert.equal(edited.get(overlayPath('dev')), 'locals:\n  queue_retention_seconds: 86400\n');
  assert.equal(edited.get(overlayPath('production')), 'locals:\n  queue_retention_seconds: 1209600\n');
  assert.equal(foldsAgreeAfter(stack, suggestion, edited), true);
});

test('a tied string or boolean takes "" or false in the common layer, and a block with two differences is not offered', () => {
  const holder = (name, enabled) => `queue:\n  events:\n    name: ${name}\n    enabled: ${enabled}\n    size: 1\n`;
  const dsl = layeredDsl({ layers: unitLayers(1) });
  const tied = (values) => {
    const overlayTexts = Object.fromEntries(OVERLAYS.map((name, index) => [name, holder(...values[index])]));
    return stackOf(dsl, texts('schema_version: "3"\n', overlayTexts));
  };
  const tiedNames = tied([['mock-dev', true], ['mock-staging', true], ['mock-uat', true], ['mock-production', true]]);
  const [nameMove] = commonLayerSuggestions(tiedNames, noSchemaChecks);
  const nameEdited = editedTexts(tiedNames, nameMove);
  assert.match(nameEdited.get(common), /^ {2}queue_name: ""$/m);
  assert.equal(foldsAgreeAfter(tiedNames, nameMove, nameEdited), true);
  const tiedFlags = tied([['mock-name', true], ['mock-name', false], ['mock-name', true], ['mock-name', false]]);
  const [flagMove] = commonLayerSuggestions(tiedFlags, noSchemaChecks);
  const flagEdited = editedTexts(tiedFlags, flagMove);
  assert.match(flagEdited.get(common), /^ {2}queue_enabled: false$/m);
  assert.equal(foldsAgreeAfter(tiedFlags, flagMove, flagEdited), true);
  const both = tied([['mock-dev', true], ['mock-staging', false], ['mock-uat', true], ['mock-production', false]]);
  assert.deepEqual(commonLayerSuggestions(both, noSchemaChecks), []);
  const mixed = stackOf(dsl, texts('schema_version: "3"\n', {
    dev: holder('mock-dev', true),
    staging: holder(7, true),
    uat: holder('mock-uat', true),
  }));
  assert.deepEqual(commonLayerSuggestions(mixed, noSchemaChecks), []);
});

test('a local every overlay repeats moves over the common layer\'s value, and an emptied locals map goes with it', () => {
  const holder = (env) => `schema_version: "3"\nenv: ${env}\n\nlocals:\n  cluster_name: \${env}-mock-sg\ndata_source: {}\n`;
  const stack = stackOf(layeredDsl(), texts('schema_version: "3"\nlocals:\n  cluster_name: ""\nrds: {}\n', {
    dev: holder('dev'),
    staging: holder('staging'),
  }));
  const moves = commonLayerSuggestions(stack, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.deepEqual(moves.map((found) => [found.path, found.holders]), [[['locals', 'cluster_name'], ['dev', 'staging']]]);
  const edited = editedTexts(stack, moves[0]);
  assert.equal(edited.get(common), 'schema_version: "3"\nlocals:\n  cluster_name: ${env}-mock-sg\nrds: {}\n');
  assert.equal(edited.get(overlayPath('dev')), 'schema_version: "3"\nenv: dev\n\ndata_source: {}\n');
  assert.equal(foldsAgreeAfter(stack, moves[0], edited), true);
});

test('the value most overlays\' folds hold moves, an overlay holding another keeps it, and one without inherits the old', () => {
  const commonText = 'rds:\n  defaults:\n    capacity: provisioned\n';
  const serverless = 'rds:\n  defaults:\n    capacity: serverless\n';
  const missing = stackOf(layeredDsl(), texts(commonText, {
    dev: serverless,
    staging: serverless,
    uat: serverless,
    production: 'other: 1\n',
  }));
  const [inherited] = commonLayerSuggestions(missing, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.deepEqual(inherited.path, ['rds', 'defaults', 'capacity']);
  assert.deepEqual([inherited.holders, inherited.keepsCommonValue], [['dev', 'staging', 'uat'], ['production']]);
  const edited = editedTexts(missing, inherited);
  assert.equal(edited.get(common), serverless);
  assert.equal(edited.get(overlayPath('dev')), '');
  assert.equal(edited.get(overlayPath('production')), `other: 1\n${commonText}`);
  assert.equal(foldsAgreeAfter(missing, inherited, edited), true);
  const outvoted = stackOf(layeredDsl(), texts(commonText, {
    dev: serverless,
    staging: serverless,
    uat: 'rds:\n  defaults:\n    capacity: mock-other\n',
  }));
  const [kept] = commonLayerSuggestions(outvoted, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.deepEqual([kept.holders, kept.keepsOwnValue], [['dev', 'staging'], ['uat']]);
  const keptEdited = editedTexts(outvoted, kept);
  assert.equal(keptEdited.has(overlayPath('uat')), false);
  assert.equal(foldsAgreeAfter(outvoted, kept, keptEdited), true);
});

test('a map local most overlays repeat moves, and an overlay without it opts out with {}', () => {
  const holder = 'locals:\n  tags:\n    team: mock-team\n';
  const stack = stackOf(layeredDsl(), texts('locals:\n  owner: mock-owner\n', {
    dev: holder,
    staging: holder,
    uat: holder,
    production: 'locals:\n  zone: mock-zone\n',
  }));
  const [move] = commonLayerSuggestions(stack, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.deepEqual([move.path, move.absent], [['locals', 'tags'], ['production']]);
  const edited = editedTexts(stack, move);
  assert.equal(edited.get(common), 'locals:\n  owner: mock-owner\n  tags:\n    team: mock-team\n');
  assert.equal(edited.get(overlayPath('production')), 'locals:\n  tags: {}\n  zone: mock-zone\n');
  assert.equal(foldsAgreeAfter(stack, move, edited), true);
});

test('a repeated value past the duplicate check\'s depth does not move, and one under a map the common layer lacks moves with the map', () => {
  const deep = stackOf(layeredDsl(), texts('data_source:\n  kms:\n    type: mock-old\n', {
    dev: 'data_source:\n  kms:\n    type: mock-new\n',
    staging: 'data_source:\n  kms:\n    type: mock-new\n',
  }));
  assert.deepEqual(commonLayerSuggestions(deep, noSchemaChecks).filter((found) => found.kind === 'move'), []);
  const unheldParent = stackOf(layeredDsl(), texts('rds: {}\n', {
    dev: 'queue:\n  events:\n    size: 1\n    name: mock-dev\n',
    staging: 'queue:\n  events:\n    size: 1\n    name: 7\n',
  }));
  const [move, ...rest] = commonLayerSuggestions(unheldParent, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.equal(rest.length, 0);
  assert.deepEqual(move.path, ['queue', 'events', 'size']);
  const edited = editedTexts(unheldParent, move);
  assert.equal(edited.get(common), 'rds: {}\nqueue:\n  events:\n    size: 1\n');
  assert.equal(edited.get(overlayPath('dev')), 'queue:\n  events:\n    name: mock-dev\n');
  assert.equal(edited.get(overlayPath('staging')), 'queue:\n  events:\n    name: 7\n');
  assert.equal(foldsAgreeAfter(unheldParent, move, edited), true);
});

test('a repeated map an overlay keeping its own map would merge with is not moved, and its keys are', () => {
  const shared = 'locals:\n  registry: mock-registry\n  bucket: mock-b\n  extra: mock-extra\n';
  const stack = stackOf(layeredDsl(), texts('schema_version: "3"\n', {
    dev: 'locals:\n  registry: mock-registry\n  bucket: mock-a\n',
    staging: shared,
    uat: shared,
  }));
  const moves = commonLayerSuggestions(stack, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.deepEqual(moves.map((found) => [found.path.join('.'), found.keepsOwnValue]), [
    ['locals.registry', []],
    ['locals.bucket', ['dev']],
  ]);
  for (const move of moves) assert.equal(foldsAgreeAfter(stack, move, editedTexts(stack, move)), true);
});

test('a moved block keeps the blank lines the first overlay holding it puts around it', () => {
  const holder = (env, gap) => `schema_version: "3"\nenv: ${env}\n${gap}data_source:\n  kms:\n    type: mock\n`;
  const stack = stackOf(layeredDsl(), texts('schema_version: "3"\nrds:\n  capacity: mock\n', {
    dev: holder('dev', '\n'),
    staging: holder('staging', ''),
    uat: holder('uat', ''),
  }));
  const [suggestion] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.deepEqual(suggestion.path, ['data_source', 'kms']);
  assert.equal(
    editedTexts(stack, suggestion).get(common),
    'schema_version: "3"\nrds:\n  capacity: mock\n\ndata_source:\n  kms:\n    type: mock\n',
  );
});

test('a block held by half the overlays or fewer is not suggested', () => {
  const stack = stackOf(layeredDsl(), texts('', {
    dev: 'queue:\n  events:\n    a: 1\n',
    staging: 'queue:\n  events:\n    a: 1\n',
    uat: 'other: 1\n',
    production: 'other: 2\n',
  }));
  assert.deepEqual(commonLayerSuggestions(stack, noSchemaChecks), []);
});

test('a duplicate of the common layer is deleted from its overlay, within the configured depths', () => {
  const commonText = 'schema_version: "3"\nqueue:\n  events:\n    a: 1\n  deep:\n    inner:\n      b: 1\nempty:\n';
  const stack = stackOf(layeredDsl(), texts(commonText, {
    dev: 'queue:\n  events:\n    a: 1\n  other:\n    b: 1\n  deep:\n    inner:\n      b: 1\n',
    staging: 'schema_version: "3"\nqueue:\n  events: {a: 1}\nempty:\n',
  }));
  const suggestions = commonLayerSuggestions(stack, noSchemaChecks);
  assert.deepEqual(suggestions.map((suggestion) => [suggestion.kind, suggestion.holders, suggestion.path]), [
    ['delete', ['dev'], ['queue', 'events']],
    ['delete', ['dev'], ['queue', 'deep']],
    ['delete', ['staging'], ['queue', 'events']],
  ]);
  const [devEvents, , stagingEvents] = suggestions;
  assert.deepEqual(devEvents.absent, []);
  assert.deepEqual(devEvents.marks.map((mark) => [mark.file, mark.range.start]), [
    [overlayPath('dev'), { line: 1, character: 9 }],
  ]);
  const devEdited = editedTexts(stack, devEvents);
  assert.equal(devEdited.get(overlayPath('dev')), 'queue:\n  other:\n    b: 1\n  deep:\n    inner:\n      b: 1\n');
  assert.equal(devEdited.has(common), false);
  assert.equal(foldsAgreeAfter(stack, devEvents, devEdited), true);
  assert.equal(editedTexts(stack, stagingEvents).get(overlayPath('staging')), 'schema_version: "3"\nempty:\n');
  const shallow = stackOf(layeredDsl({
    layers: {
      overlay_folders: OVERLAYS,
      common_layer_discovery: 'ancestor',
      duplicate_check: { depth: 1, key_depths: {}, skip_keys: [] },
    },
  }), texts('queue:\n  events:\n    a: 1\n', { dev: 'queue:\n  events:\n    a: 1\n  other: 2\n' }));
  assert.deepEqual(commonLayerSuggestions(shallow, noSchemaChecks), []);
  const keyDepth = stackOf(layeredDsl(), texts('data_source:\n  vpc:\n    name: x\n    tags: {a: 1}\n', {
    dev: 'data_source:\n  vpc:\n    name: y\n    tags: {a: 1}\n',
  }));
  assert.deepEqual(commonLayerSuggestions(keyDepth, noSchemaChecks), []);
});

test('without locals a block with a difference is not moved, and one without a difference is', () => {
  const dsl = { ...layeredDsl({ layers: unitLayers(1) }), locals: null };
  const differing = stackOf(dsl, texts('', {
    dev: 'queue:\n  size: 1\n  a: 1\n',
    staging: 'queue:\n  size: 2\n  a: 1\n',
    uat: 'queue:\n  size: 2\n  a: 1\n',
  }));
  assert.deepEqual(commonLayerSuggestions(differing, noSchemaChecks), []);
  const sameText = 'queue:\n  size: 2\n  a: 1\n';
  const same = stackOf(dsl, texts('', { dev: sameText, staging: sameText, uat: sameText }));
  const [move, ...rest] = commonLayerSuggestions(same, noSchemaChecks);
  assert.equal(rest.length, 0);
  assert.deepEqual([move.path, move.differencePaths], [['queue'], []]);
  const edited = editedTexts(same, move);
  assert.equal(edited.get(common), sameText);
  assert.equal(edited.get(overlayPath('dev')), '');
  assert.equal(foldsAgreeAfter(same, move, edited), true);
});

test('a block whose every leaf differs, or whose keys differ, moves nothing', () => {
  const stack = stackOf(layeredDsl(), texts('', {
    dev: 'queue:\n  size: 1\n',
    staging: 'queue:\n  size: 2\n',
    uat: 'queue:\n  size: 3\n  extra: 1\n',
  }));
  assert.deepEqual(commonLayerSuggestions(stack, noSchemaChecks), []);
});

test('a local is named by the block\'s key and the nearest named key, leaving out declared names, calls and list items', () => {
  const withCalls = layeredDsl({ function: markerFunction(), layers: unitLayers(1) });
  const named = (value) => `queue:\n  events:\n    tags fn.merge*:\n      - team: mock\n      - env: ${value}\n    kept: x\n`;
  const namedCall = stackOf(withCalls, texts('', {
    dev: named('mock-dev'),
    staging: named('mock-dev'),
    uat: named('mock-uat'),
  }));
  assert.equal(commonLayerSuggestions(namedCall, noSchemaChecks)[0].differences[0].name, 'queue_env');
  const nameless = (value) => `queue:\n  events:\n    fn.concat*:\n      - [mock-a]\n      - [${value}]\n    kept: x\n`;
  const namelessCall = stackOf(withCalls, texts('', {
    dev: nameless('mock-dev'),
    staging: nameless('mock-dev'),
    uat: nameless('mock-uat'),
  }));
  assert.equal(commonLayerSuggestions(namelessCall, noSchemaChecks)[0].differences[0].name, 'queue');
});

test('a local name the stack already declares takes the next named key up, then the block\'s ancestors', () => {
  const holder = (size) => `queue:\n  events:\n    limits:\n      size: ${size}\n    kept: x\n`;
  const nextKeyUp = stackOf(layeredDsl({ layers: unitLayers(1) }), texts('locals:\n  queue_size: taken\n', {
    dev: holder(1),
    staging: holder(2),
    uat: holder(2),
  }));
  const [suggestion] = commonLayerSuggestions(nextKeyUp, noSchemaChecks);
  assert.deepEqual(suggestion.path, ['queue']);
  assert.equal(suggestion.differences[0].name, 'queue_limits_size');
});

test('a placeholder-only local reference wraps the name in the placeholder', () => {
  const dsl = layeredDsl({}, ['whole_placeholder', 'placeholder_in_text']);
  assert.equal(localReferenceText(dsl, 'mock_name'), '${local.mock_name}');
  assert.equal(localReferenceText({ ...dsl, placeholder: null }, 'mock_name'), null);
  assert.equal(localReferenceText(layeredDsl(), 'Bad-Name'), null);
});

test('a flow map the edits must write into, or a multi-line difference, is not suggested', () => {
  const flowCommon = stackOf(layeredDsl(), texts('queue: {other: 1}\n', {
    dev: 'queue:\n  events:\n    a: 1\n',
    staging: 'queue:\n  events:\n    a: 1\n',
    uat: 'queue:\n  events:\n    a: 1\n',
  }));
  assert.deepEqual(commonLayerSuggestions(flowCommon, noSchemaChecks), []);
  const multiLine = stackOf(layeredDsl(), texts('', {
    dev: 'queue:\n  kept: 1\n  script: |\n    one\n',
    staging: 'queue:\n  kept: 1\n  script: |\n    two\n',
    uat: 'queue:\n  kept: 1\n  script: |\n    three\n',
  }));
  assert.deepEqual(commonLayerSuggestions(multiLine, noSchemaChecks).map((found) => found.path), [['queue', 'kept']]);
});

test('a stack with no common layer file gets the moves that create it, starting with the keys every overlay states', () => {
  const holder = (env, size) => `schema_version: "3"\nenv: ${env}\n\nqueue:\n  events:\n    size: ${size}\n    kept: x\n`;
  const noCommon = stackOf(layeredDsl({ layers: unitLayers(1) }), texts('', {
    dev: holder('dev', 1),
    staging: holder('staging', 1),
    production: holder('production', 2),
  }));
  noCommon.files.delete(common);
  const [move, ...rest] = commonLayerSuggestions(noCommon, noSchemaChecks);
  assert.deepEqual(rest, []);
  assert.deepEqual([move.kind, move.path, move.createsCommonLayer], ['move', ['queue'], true]);
  const edited = editedTexts(noCommon, move);
  assert.equal(edited.get(common), [
    'schema_version: "3"',
    '',
    'locals:',
    '  queue_size: 1',
    '',
    'queue:',
    '  events:',
    '    size: local.queue_size',
    '    kept: x',
    '',
  ].join('\n'));
  assert.equal(edited.get(overlayPath('dev')), 'schema_version: "3"\nenv: dev\n');
  assert.equal(foldsAgreeAfter(noCommon, move, edited), true);
});

test('a stack with fewer than two overlay files, or a common layer that is not a map, has no suggestions', () => {
  const dsl = layeredDsl();
  const oneOverlay = stackOf(dsl, texts('', { dev: 'queue:\n  a: 1\n' }));
  assert.deepEqual(commonLayerSuggestions(oneOverlay, noSchemaChecks), []);
  const listCommon = stackOf(dsl, texts('- listed\n', {
    dev: 'queue:\n  a: 1\n',
    staging: 'queue:\n  a: 1\n',
  }));
  assert.deepEqual(commonLayerSuggestions(listCommon, noSchemaChecks), []);
});

function mockSchema(queueSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    definitions: { mock_queue: queueSchema },
    properties: {
      other: {},
      ...(queueSchema ? { queue: { $ref: '#/definitions/mock_queue', description: '[optional] mock queue' } } : {}),
    },
  };
}

const mockSchemas = {
  'requires-events': mockSchema({ type: 'object', required: ['events'], properties: { events: { type: 'object' } } }),
  'requires-events-reworded': mockSchema({
    type: 'object',
    description: 'reworded',
    required: ['events'],
    properties: { events: { type: 'object', title: 'mock events' } },
  }),
  'events-optional': mockSchema({ type: 'object', properties: { events: { type: 'object' } } }),
  'no-queue': mockSchema(null),
  'events-conditional': mockSchema({
    type: 'object',
    properties: { events: { type: 'object', description: '[~required] mock events' } },
  }),
};

function stackWithSchemas(schemaNames) {
  const stack = stackOf(layeredDsl({ layers: unitLayers(1) }), texts('', {
    dev: 'queue:\n  events:\n    a: 1\n',
    staging: 'queue:\n  events:\n    a: 1\n',
    uat: 'queue:\n  events:\n    a: 1\n',
    production: 'other: 1\n',
  }));
  stack.schemas = new Map(OVERLAYS.map((name) => [overlayPath(name), { hash: schemaNames[name] }]));
  return stack;
}

const mockSchemaChecks = createSchemaChecks((schemaHash) => mockSchemas[schemaHash]);

test('a block whose node differs between the overlays\' schemas is a potential move with no edits', () => {
  const stack = stackWithSchemas({
    dev: 'requires-events',
    staging: 'requires-events',
    uat: 'requires-events-reworded',
    production: 'no-queue',
  });
  const [suggestion, ...rest] = commonLayerSuggestions(stack, mockSchemaChecks);
  assert.equal(rest.length, 0);
  assert.equal(suggestion.kind, 'potential_move');
  assert.deepEqual(suggestion.path, ['queue']);
  assert.deepEqual(suggestion.schemaGroups, [
    { overlays: ['dev', 'staging', 'uat'], state: 'constrained' },
    { overlays: ['production'], state: 'not_allowed' },
  ]);
  assert.deepEqual(suggestion.optOutFailures, []);
  assert.equal(suggestion.edits.size, 0);
  assert.equal(suggestion.marks.length, 3);
});

test('a block whose opt-out the shared schema node rejects is a potential move naming the overlay', () => {
  const stack = stackWithSchemas({
    dev: 'requires-events',
    staging: 'requires-events',
    uat: 'requires-events',
    production: 'requires-events',
  });
  const [suggestion] = commonLayerSuggestions(stack, mockSchemaChecks);
  assert.equal(suggestion.kind, 'potential_move');
  assert.deepEqual(suggestion.schemaGroups, []);
  assert.deepEqual(suggestion.optOutFailures, [
    {
      overlay: 'production',
      valueText: '{}',
      failures: [{ kind: 'message', text: "must have required property 'events'", alternatives: [] }],
    },
  ]);
  assert.equal(suggestion.edits.size, 0);
});

test('a block whose opt-out passes the shared schema node is a move', () => {
  const stack = stackWithSchemas({
    dev: 'events-optional',
    staging: 'events-optional',
    uat: 'events-optional',
    production: 'events-optional',
  });
  const [suggestion] = commonLayerSuggestions(stack, mockSchemaChecks);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.optOutConditionalFields, []);
  assert.deepEqual(suggestion.absent, ['production']);
  assert.equal(editedTexts(stack, suggestion).get(overlayPath('production')), 'other: 1\nqueue: {}\n');
});

test('a block whose opt-out leaves out a conditionally required field stays a move, naming the field', () => {
  const stack = stackWithSchemas({
    dev: 'events-conditional',
    staging: 'events-conditional',
    uat: 'events-conditional',
    production: 'events-conditional',
  });
  const [suggestion] = commonLayerSuggestions(stack, mockSchemaChecks);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.optOutConditionalFields, [{ overlay: 'production', fields: ['queue.events'] }]);
  assert.ok(suggestion.edits.size > 0);
});

const resourceUnits = () => layeredDsl({ layers: unitLayers(2) });

test('a resource moves whole: its keys never move one by one, and a list an overlay lacks is its one difference', () => {
  const lacking = 'queue:\n  invoke:\n    name: mock-invoke\n    retention_seconds: 60\n';
  const held = `${lacking}    publishers:\n      - mock-role\n`;
  const stack = stackOf(resourceUnits(), texts('schema_version: "3"\n', {
    dev: lacking,
    staging: held,
    uat: held,
  }));
  const [move, ...rest] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.equal(rest.length, 0);
  assert.deepEqual([move.kind, move.path, move.holders], ['move', ['queue', 'invoke'], ['dev', 'staging', 'uat']]);
  assert.deepEqual(move.differencePaths, [['queue', 'invoke', 'publishers']]);
  assert.deepEqual(move.optOuts, [{ overlay: 'dev', relativePath: ['publishers'], valueText: '[]' }]);
  const edited = editedTexts(stack, move);
  assert.equal(edited.get(common), [
    'schema_version: "3"',
    '',
    'locals:',
    '  invoke_publishers:',
    '    - mock-role',
    '',
    'queue:',
    '  invoke:',
    '    name: mock-invoke',
    '    retention_seconds: 60',
    '    publishers: local.invoke_publishers',
    '',
  ].join('\n'));
  assert.equal(edited.get(overlayPath('dev')), 'locals:\n  invoke_publishers: []\n');
  assert.equal(edited.get(overlayPath('staging')), '');
  assert.equal(foldsAgreeAfter(stack, move, edited), true);
});

test('a list whose items differ in number is one difference, declared on the lines below its local', () => {
  const holder = (hosts) => [
    'queue:',
    '  invoke:',
    '    name: mock-invoke',
    '    hosts:',
    ...hosts.map((host) => `      - ${host}`),
    '',
  ].join('\n');
  const stack = stackOf(resourceUnits(), texts('', {
    dev: holder(['mock-a']),
    staging: holder(['mock-a', 'mock-b']),
    uat: holder(['mock-a', 'mock-b']),
  }));
  const [move] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.deepEqual(move.differencePaths, [['queue', 'invoke', 'hosts']]);
  const edited = editedTexts(stack, move);
  assert.match(edited.get(common), /^locals:\n {2}invoke_hosts:\n {4}- mock-a\n {4}- mock-b\n/);
  assert.match(edited.get(common), /^ {4}hosts: local\.invoke_hosts$/m);
  assert.equal(edited.get(overlayPath('dev')), 'locals:\n  invoke_hosts:\n    - mock-a\n');
  assert.equal(foldsAgreeAfter(stack, move, edited), true);
});

test('a scalar an overlay lacks takes its schema default as the one difference, and without one nothing moves', () => {
  const held = 'queue:\n  invoke:\n    name: mock-invoke\n    fifo: true\n';
  const lacking = 'queue:\n  invoke:\n    name: mock-invoke\n';
  const fields = (fifo) => ({ type: 'object', properties: { name: { type: 'string' }, fifo } });
  const schemas = {
    'fifo-default': { type: 'object', properties: { queue: { type: 'object', additionalProperties: fields({
      type: 'boolean',
      default: false,
    }) } } },
    'fifo-no-default': { type: 'object', properties: { queue: { type: 'object', additionalProperties: fields({
      type: 'boolean',
    }) } } },
  };
  const checks = createSchemaChecks((schemaHash) => schemas[schemaHash]);
  const stackWith = (schemaName) => {
    const stack = stackOf(resourceUnits(), texts('', { dev: lacking, staging: held, uat: held }));
    stack.schemas = new Map(OVERLAYS.map((name) => [overlayPath(name), { hash: schemaName }]));
    return stack;
  };
  const defaulted = stackWith('fifo-default');
  const [move] = commonLayerSuggestions(defaulted, checks);
  assert.deepEqual(move.optOuts, [{ overlay: 'dev', relativePath: ['fifo'], valueText: 'false' }]);
  const edited = editedTexts(defaulted, move);
  assert.equal(edited.get(overlayPath('dev')), 'locals:\n  invoke_fifo: false\n');
  assert.equal(foldsAgreeAfter(defaulted, move, edited), true);
  assert.deepEqual(commonLayerSuggestions(stackWith('fifo-no-default'), checks), []);
});

test('a list unit an overlay lacks opts out with [] written at its path, and an empty map or list is not moved', () => {
  const stack = stackOf(layeredDsl(), texts('', {
    dev: 'queue:\n  invoke:\n    hosts: [mock-a]\n    tags: {}\n',
    staging: 'queue:\n  invoke:\n    hosts: [mock-a]\n    tags: {}\n',
    uat: 'queue:\n  invoke:\n    tags: {}\n',
  }));
  const [move, ...rest] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.equal(rest.length, 0);
  assert.deepEqual([move.path, move.absent, move.differencePaths], [
    ['queue', 'invoke', 'hosts'],
    ['uat'],
    [['queue', 'invoke', 'hosts']],
  ]);
  const edited = editedTexts(stack, move);
  assert.equal(edited.get(overlayPath('uat')), 'queue:\n  invoke:\n    hosts: []\n    tags: {}\n');
  assert.equal(foldsAgreeAfter(stack, move, edited), true);
});

test('neighboring moves combine while the combined move holds at most one difference', () => {
  const holder = (name) => [
    'service:',
    '  main:',
    '    alpha:',
    '      size: 1',
    '    beta:',
    '      kind: mock-kind',
    `      size: ${name}`,
    '    gamma:',
    '      kind: mock-kind',
    '      size: 3',
    '',
  ].join('\n');
  const dsl = layeredDsl();
  const units = stackOf(dsl, texts('service:\n  main:\n    kept: mock-kept\n', {
    dev: holder('mock-dev'),
    staging: holder('mock-shared'),
    uat: holder('mock-shared'),
  }));
  const moves = commonLayerSuggestions(units, noSchemaChecks).filter((found) => found.kind === 'move');
  const memberKeys = moves.map((found) => found.memberPaths.map((memberPath) => memberPath[2]));
  assert.deepEqual(memberKeys, [['alpha', 'beta', 'gamma']]);
  assert.equal(moves[0].differencePaths.length, 1);
  const twoDifferences = stackOf(dsl, texts('service:\n  main:\n    kept: mock-kept\n', {
    dev: holder('mock-dev').replace('size: 3', 'size: 4'),
    staging: holder('mock-shared'),
    uat: holder('mock-shared'),
  }));
  const split = commonLayerSuggestions(twoDifferences, noSchemaChecks).filter((found) => found.kind === 'move');
  assert.deepEqual(split.map((found) => found.differencePaths.length), [1, 1]);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');
const { createNodeIds } = require('../lib/node-ids');
const {
  commonLayerSuggestions,
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
} = require('./config-builders');

const OVERLAYS = ['dev', 'staging', 'uat', 'production'];
const common = '/repo/mock.yml';
const overlayPath = (name) => `/repo/${name}/mock.yml`;
const noSchemaChecks = createSchemaChecks(() => null);

const resourceKeyOrders = [
  { path: '$.locals', skip_keys: [], includes_subtree: false, order: 'alphabetical' },
  { path: '$', skip_keys: [], includes_subtree: false, order: 'significance' },
  { path: '$.*', skip_keys: ['locals'], includes_subtree: false, order: 'significance' },
  { path: '$', skip_keys: [], includes_subtree: true, order: 'alphabetical' },
];

function layeredDsl(fields = {}, localPositions = ['whole_scalar', 'whole_placeholder', 'placeholder_in_text']) {
  return parsedDsl(dslEntry('resource', {
    layers: {
      overlay_folders: OVERLAYS,
      common_layer_discovery: 'ancestor',
      duplicate_check: { depth: 3, key_depths: { data_source: 2 }, skip_keys: ['schema_version'] },
    },
    key_orders: resourceKeyOrders,
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

test('a block most overlays hold moves to the common layer, each difference a local', () => {
  const stack = stackOf(layeredDsl(), texts('locals:\n  team: mock-team\n', {
    dev: 'queue:\n  events:\n    retention_seconds: 86400\n    max_receive_count: 5\n',
    staging: 'queue:\n  events:\n    retention_seconds: 86400  # same\n    max_receive_count: 5\n',
    uat: 'other: {}\n',
    production: 'locals:\n  zone: mock-zone\nqueue:\n  events: { retention_seconds: 1209600, max_receive_count: 5 }\n',
  }));
  const [suggestion, ...rest] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.equal(rest.length, 0);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.path, ['queue']);
  assert.deepEqual(suggestion.holders, ['dev', 'staging', 'production']);
  assert.deepEqual(suggestion.absent, ['uat']);
  assert.deepEqual(suggestion.differences, [{
    name: 'queue_events_retention_seconds',
    referenceText: 'local.queue_events_retention_seconds',
    values: [{ text: '86400', overlays: ['dev', 'staging'] }, { text: '1209600', overlays: ['production'] }],
  }]);
  assert.deepEqual(suggestion.marks.map((mark) => [mark.file, mark.range.start]), [
    [overlayPath('dev'), { line: 0, character: 6 }],
    [overlayPath('staging'), { line: 0, character: 6 }],
    [overlayPath('production'), { line: 2, character: 6 }],
  ]);
  const edited = editedTexts(stack, suggestion);
  assert.equal(edited.get(common), [
    'locals:',
    '  queue_events_retention_seconds: 86400',
    '  team: mock-team',
    'queue:',
    '  events:',
    '    retention_seconds: local.queue_events_retention_seconds',
    '    max_receive_count: 5',
    '',
  ].join('\n'));
  assert.equal(edited.get(overlayPath('dev')), '');
  assert.equal(edited.get(overlayPath('uat')), 'queue: {}\nother: {}\n');
  assert.equal(
    edited.get(overlayPath('production')),
    'locals:\n  queue_events_retention_seconds: 1209600\n  zone: mock-zone\n',
  );
  assert.equal(foldsAgreeAfter(stack, suggestion, edited), true);
  const changedCount = edited.get(common).replace('max_receive_count: 5', 'max_receive_count: 6');
  const tampered = new Map(edited).set(common, changedCount);
  assert.equal(foldsAgreeAfter(stack, suggestion, tampered), false);
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

test('without locals a block with differences is not moved, and an equal block inside it is', () => {
  const dsl = { ...layeredDsl(), locals: null };
  const stack = stackOf(dsl, texts('', {
    dev: 'queue:\n  size: 1\n  events:\n    a: 1\n',
    staging: 'queue:\n  size: 2\n  events:\n    a: 1\n',
    uat: 'queue:\n  size: 3\n  events:\n    a: 1\n',
    production: 'other: 1\n',
  }));
  const suggestions = commonLayerSuggestions(stack, noSchemaChecks);
  assert.deepEqual(suggestions.map((suggestion) => suggestion.path), [['queue', 'events']]);
  assert.deepEqual(suggestions[0].absent, ['production']);
  const edited = editedTexts(stack, suggestions[0]);
  assert.equal(edited.get(common), 'queue:\n  events:\n    a: 1\n');
  assert.equal(edited.get(overlayPath('dev')), 'queue:\n  size: 1\n');
  assert.equal(foldsAgreeAfter(stack, suggestions[0], edited), true);
});

test('a block whose every leaf differs, or whose keys differ, moves nothing', () => {
  const stack = stackOf(layeredDsl(), texts('', {
    dev: 'queue:\n  size: 1\n',
    staging: 'queue:\n  size: 2\n',
    uat: 'queue:\n  size: 3\n  extra: 1\n',
  }));
  assert.deepEqual(commonLayerSuggestions(stack, noSchemaChecks), []);
});

test('a local name the stack declares takes its ancestors\' keys in front', () => {
  const stack = stackOf(layeredDsl(), texts('locals:\n  events_size: taken\n', {
    dev: 'queue:\n  events:\n    size: 1\n    kept: x\n',
    staging: 'queue:\n  events:\n    size: 2\n    kept: x\n',
    uat: 'queue:\n  events:\n    size: 2\n    kept: x\n',
  }));
  const [suggestion] = commonLayerSuggestions(stack, noSchemaChecks);
  assert.deepEqual(suggestion.path, ['queue']);
  assert.equal(suggestion.differences[0].name, 'queue_events_size');
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
  assert.deepEqual(commonLayerSuggestions(multiLine, noSchemaChecks), []);
});

test('a stack with fewer than two overlay files, or no common layer, has no suggestions', () => {
  const dsl = layeredDsl();
  const oneOverlay = stackOf(dsl, texts('', { dev: 'queue:\n  a: 1\n' }));
  assert.deepEqual(commonLayerSuggestions(oneOverlay, noSchemaChecks), []);
  const noCommon = stackOf(dsl, texts('', { dev: 'queue:\n  a: 1\n', staging: 'queue:\n  a: 1\n' }));
  noCommon.files.delete(common);
  assert.deepEqual(commonLayerSuggestions(noCommon, noSchemaChecks), []);
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
  const stack = stackOf(layeredDsl(), texts('', {
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
  assert.equal(editedTexts(stack, suggestion).get(overlayPath('production')), 'queue: {}\nother: 1\n');
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

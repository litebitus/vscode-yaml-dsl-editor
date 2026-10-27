const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../lib/config');
const { analyzeDocument } = require('../lib/analyze');
const { collectSymbols } = require('../lib/symbols');
const {
  loopContextOf,
  loopsOf,
  loopOfVariableAt,
  loopVariablesEnclosing,
  loopVariableDocumentationOf,
  expandedTreeOf,
  expandedValueOf,
  expandedPathOf,
  sourceProblemsOf,
} = require('../lib/loops');
const {
  configText,
  dslEntry,
  scope,
  declaration,
  reference,
  markerFunction,
} = require('./config-builders');

const mockArgument = (name, type) => ({ name, type, required: true, repeated: false, description: null });

const table = {
  ForEach: {
    description: 'Repeats the mock fragment.',
    arguments: [
      mockArgument('identifier', 'text'),
      mockArgument('collection', 'list'),
      mockArgument('fragment', 'map'),
    ],
    return: null,
    macro: {
      kind: 'loop',
      nameSuffixPattern: '::[A-Za-z0-9]+',
      unmarkedKeyPaths: [],
      roles: { loopVariables: 'identifier', collection: 'collection', body: 'fragment' },
    },
  },
};

const [dsl] = parseConfig(configText(dslEntry('mock-template', {
  placeholder: { pattern: '[$&]\\{(?<body>[^}]+)\\}', unscanned_paths: [] },
  scopes: { LOGICAL_ID: scope() },
  declarations: [declaration('$.Resources.*', 'LOGICAL_ID')],
  references: [
    reference('^(?<name>[A-Za-z0-9]+)$', 'LOGICAL_ID', { positions: ['whole_placeholder', 'placeholder_in_text'] }),
  ],
  function: {
    definitions: ['schema'],
    call_result_reference_positions: [],
    calls_not_allowed_at: [],
    marker_function: { call_marker: 'Fn::', splat_operator: null, calls_without_name_allowed: true },
  },
  loops: { scope_name: 'LOGICAL_ID' },
}))).dsls;

const context = loopContextOf(dsl, table);

const text = [
  'Resources:',
  '  Fn::ForEach::Topics:',
  '    - TopicName',
  '    - [MockA, MockB]',
  '    - Topic${TopicName}:',
  '        Type: mock-type',
  '        Label: mock-${TopicName}-label',
  '        Fn::ForEach::Queues:',
  '          - QueueName',
  '          - [One]',
  '          - Queue${TopicName}${QueueName}: { Type: mock-queue }',
  '  Fn::ForEach::Unknown:',
  '    - ItemName',
  '    - Fn::Mock: [x]',
  '    - Item&{ItemName}: { Type: mock-type }',
  '  MockBucket:',
  '    Type: mock-type',
  '',
].join('\n');

const doc = analyzeDocument(text, '/repo/mock.yml', dsl);

test('a loop is a call of a loop macro, with its loop variables, its literal items and its body path', () => {
  const loops = loopsOf(doc.tree, context);
  assert.deepEqual(loops.map((loop) => [loop.key, loop.holdingPath, loop.bodyPath, loop.variables, loop.items]), [
    ['Fn::ForEach::Topics', ['Resources'], ['Resources', 'Fn::ForEach::Topics', 2], ['TopicName'], ['MockA', 'MockB']],
    [
      'Fn::ForEach::Queues',
      ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}'],
      ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}', 'Fn::ForEach::Queues', 2],
      ['QueueName'],
      ['One'],
    ],
    ['Fn::ForEach::Unknown', ['Resources'], ['Resources', 'Fn::ForEach::Unknown', 2], ['ItemName'], null],
  ]);
  assert.equal(loops[1].enclosing, loops[0]);
  assert.deepEqual(loops[0].variableRanges[0].start, { line: 2, character: 6 });
  assert.deepEqual(loopsOf(doc.tree, loopContextOf(dsl, {})), []);
});

test('a name inside a loop\'s body that is its loop variable is the innermost loop\'s', () => {
  const loops = loopsOf(doc.tree, context);
  const queueBody = ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}', 'Fn::ForEach::Queues', 2, 'x'];
  assert.equal(loopOfVariableAt(loops, queueBody, 'TopicName'), loops[0]);
  assert.equal(loopOfVariableAt(loops, queueBody, 'QueueName'), loops[1]);
  assert.equal(loopOfVariableAt(loops, ['Resources', 'MockBucket'], 'TopicName'), null);
  assert.equal(loopOfVariableAt(loops, queueBody, 'MockBucket'), null);
});

test('a loop\'s expansion declares each item\'s names where its body lands, '
  + 'or a pattern of them where its items are unknown', () => {
  const symbols = collectSymbols(expandedTreeOf(doc.tree, context), dsl, '/repo/mock.yml', text);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.keyRange.start.line, String(symbol.namePattern)]), [
    ['TopicMockA', 4, 'undefined'],
    ['TopicMockB', 4, 'undefined'],
    ['ItemItemName', 14, '/^Item.+$/'],
    ['MockBucket', 15, 'undefined'],
  ]);
});

test('a loop\'s expansion is written into the map holding it, each item\'s body substituted in keys and text', () => {
  const { value, pathMap } = expandedValueOf(doc.value, context);
  assert.deepEqual(value, {
    Resources: {
      TopicMockA: {
        Type: 'mock-type',
        Label: 'mock-MockA-label',
        QueueMockAOne: { Type: 'mock-queue' },
      },
      TopicMockB: {
        Type: 'mock-type',
        Label: 'mock-MockB-label',
        QueueMockBOne: { Type: 'mock-queue' },
      },
      ItemItemName: { Type: 'mock-type' },
      MockBucket: { Type: 'mock-type' },
    },
  });
  const topicSource = ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}'];
  assert.deepEqual(expandedPathOf(pathMap, [...topicSource, 'Type']), ['Resources', 'TopicMockA', 'Type']);
  assert.deepEqual(
    expandedPathOf(pathMap, [...topicSource, 'Fn::ForEach::Queues', 2, 'Queue${TopicName}${QueueName}', 'Type']),
    ['Resources', 'TopicMockA', 'QueueMockAOne', 'Type'],
  );
  assert.deepEqual(expandedPathOf(pathMap, ['Resources', 'MockBucket']), ['Resources', 'MockBucket']);
});

test('a loop standing directly in another loop\'s body expands once per outer item, its names declared '
  + 'and its problems placed at its own body', () => {
  const nestedText = [
    'Resources:',
    '  Fn::ForEach::Regions:',
    '    - Region',
    '    - [East, West]',
    '    - Fn::ForEach::Buckets:',
    '        - Kind',
    '        - [Logs]',
    '        - Bucket&{Region}&{Kind}:',
    '            Type: mock-${Region}',
    '',
  ].join('\n');
  const nested = analyzeDocument(nestedText, '/repo/mock.yml', dsl);
  const symbols = collectSymbols(expandedTreeOf(nested.tree, context), dsl, '/repo/mock.yml', nestedText);
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.keyRange.start.line]), [
    ['BucketEastLogs', 7],
    ['BucketWestLogs', 7],
  ]);
  const { value, pathMap } = expandedValueOf(nested.value, context);
  assert.deepEqual(value, {
    Resources: { BucketEastLogs: { Type: 'mock-East' }, BucketWestLogs: { Type: 'mock-West' } },
  });
  const problems = sourceProblemsOf([{ path: ['Resources', 'BucketWestLogs', 'Type'], message: 'mock west' }], pathMap);
  assert.deepEqual(problems.map((problem) => [problem.path, problem.message]), [[
    ['Resources', 'Fn::ForEach::Regions', 2, 'Fn::ForEach::Buckets', 2, 'Bucket&{Region}&{Kind}', 'Type'],
    'mock west (for `West` and `Logs`)',
  ]]);
});

test('a loop whose arguments are written by name reads each role from the argument its entry names', () => {
  const byNameTable = {
    Repeat: {
      description: 'Repeats the mock body.',
      arguments: [
        mockArgument('items', 'list'),
        mockArgument('body', 'map'),
        mockArgument('variable', 'text'),
      ],
      return: null,
      macro: {
        kind: 'loop',
        nameSuffixPattern: '::[A-Za-z0-9]+',
        unmarkedKeyPaths: [],
        roles: { loopVariables: 'variable', collection: 'items', body: 'body' },
      },
    },
  };
  const byNameContext = loopContextOf(dsl, byNameTable);
  const byNameText = [
    'Resources:',
    '  Fn::Repeat::Topics:',
    '    variable: Name',
    '    items: [MockA]',
    '    body:',
    '      Topic${Name}: { Type: mock-type }',
    '',
  ].join('\n');
  const byNameDoc = analyzeDocument(byNameText, '/repo/mock.yml', dsl);
  const [loop] = loopsOf(byNameDoc.tree, byNameContext);
  assert.deepEqual([loop.variables, loop.items, loop.bodyPath], [
    ['Name'],
    ['MockA'],
    ['Resources', 'Fn::Repeat::Topics', 'body'],
  ]);
  const symbols = collectSymbols(expandedTreeOf(byNameDoc.tree, byNameContext), dsl, '/repo/mock.yml', byNameText);
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['TopicMockA']);
  const { value, pathMap } = expandedValueOf(byNameDoc.value, byNameContext);
  assert.deepEqual(value, { Resources: { TopicMockA: { Type: 'mock-type' } } });
  assert.deepEqual(
    expandedPathOf(pathMap, ['Resources', 'Fn::Repeat::Topics', 'body', 'Topic${Name}', 'Type']),
    ['Resources', 'TopicMockA', 'Type'],
  );
});

test('a problem in an expansion is placed at the body\'s source, naming the items it holds for '
  + 'unless every item shares it', () => {
  const { pathMap } = expandedValueOf(doc.value, context);
  const topicSource = ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}'];
  const problems = sourceProblemsOf([
    { path: ['Resources', 'TopicMockA', 'Label'], message: 'mock shared' },
    { path: ['Resources', 'TopicMockB', 'Label'], message: 'mock shared' },
    { path: ['Resources', 'TopicMockB', 'Type'], message: 'mock one item' },
    { path: ['Resources', 'TopicMockA', 'QueueMockAOne'], message: 'mock nested' },
    { path: ['Resources', 'ItemItemName'], message: 'mock unknown' },
    { path: ['Resources', 'MockBucket'], message: 'mock written' },
  ], pathMap);
  assert.deepEqual(problems.map((problem) => [problem.path, problem.message]), [
    [[...topicSource, 'Label'], 'mock shared'],
    [[...topicSource, 'Type'], 'mock one item (for `MockB`)'],
    [
      [...topicSource, 'Fn::ForEach::Queues', 2, 'Queue${TopicName}${QueueName}'],
      'mock nested (for `MockA` and `One`)',
    ],
    [['Resources', 'Fn::ForEach::Unknown', 2, 'Item&{ItemName}'], 'mock unknown'],
    [['Resources', 'MockBucket'], 'mock written'],
  ]);
});

const sigilTable = {
  loop: {
    description: 'Repeats the mock body.',
    arguments: [
      mockArgument('in', 'any'),
      mockArgument('body', 'any'),
      { ...mockArgument('for', 'list'), required: false, default: ['it'] },
    ],
    return: null,
    macro: {
      kind: 'loop',
      nameSuffixPattern: null,
      unmarkedKeyPaths: [],
      roles: { loopVariables: 'for', collection: 'in', body: 'body' },
    },
  },
};

const [sigilDsl] = parseConfig(configText(dslEntry('mock-sigil', {
  placeholder: { pattern: '\\$\\{(?<body>[^}]+)\\}', unscanned_paths: [] },
  function: markerFunction({ definitions: ['schema'] }),
  locals: { scope_name: 'local' },
  loops: { scope_name: 'LOOP' },
  scopes: { local: scope(), LOOP: scope() },
  declarations: [declaration('$.locals.*', 'local', { key_token: 'first_word' })],
  references: [
    reference('^local\\.(?<name>[a-z0-9_]+)', 'local', {
      positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
      text_after_name_allowed: true,
    }),
    reference('^~(?<name>[a-z_][a-z0-9_]*)', 'LOOP', {
      positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
      text_after_name_allowed: true,
    }),
  ],
}))).dsls;

const sigilContext = loopContextOf(sigilDsl, sigilTable);

const sigilText = [
  'locals:',
  '  names: [mock-a, mock-b]',
  'lambda:',
  '  mock-fn:',
  '    queue_names fn.loop:',
  '      in: [mock-a, mock-b]',
  '      body:',
  '        - "${~it}-queue"',
  '    topics fn.loop:',
  '      for: [topic]',
  '      in: [mock-a, mock-b]',
  '      body:',
  '        "${~topic}-topic":',
  '          name: ~topic',
  '    labels fn.loop:',
  '      for: [key, value]',
  '      in: { mock-y: two, mock-x: one }',
  '      body:',
  '        "${~key}": ~value',
  '    environment:',
  '      fn.loop:',
  '        in: [mock-a]',
  '        body:',
  '          "${~it}_TOPIC": "${~it}-topic"',
  '      LOG_LEVEL: info',
  '    flattened fn.flatten:',
  '      fn.loop:',
  '        in: [mock-a]',
  '        body: ["local.it-${~it}"]',
  '    unknown fn.loop:',
  '      in: local.names',
  '      body:',
  '        - ~it.label',
  '',
].join('\n');

const sigilDoc = analyzeDocument(sigilText, '/repo/mock.yml', sigilDsl);

test('a loop binds its default loop variables when it states none, '
  + 'one variable to each item, two to each key and value', () => {
  const loops = loopsOf(sigilDoc.tree, sigilContext);
  assert.deepEqual(loops.map((loop) => [loop.key, loop.variables, loop.keys, loop.items]), [
    ['queue_names fn.loop', ['it'], ['0', '1'], ['mock-a', 'mock-b']],
    ['topics fn.loop', ['topic'], ['0', '1'], ['mock-a', 'mock-b']],
    ['labels fn.loop', ['key', 'value'], ['mock-x', 'mock-y'], ['one', 'two']],
    ['fn.loop', ['it'], ['0'], ['mock-a']],
    ['fn.loop', ['it'], ['0'], ['mock-a']],
    ['unknown fn.loop', ['it'], null, null],
  ]);
  assert.deepEqual(loops[0].variableRanges[0], loops[0].keyRange);
  assert.equal(
    loopVariableDocumentationOf(loops[2], 'key'),
    '`key`: a loop variable of `labels fn.loop`, bound to `mock-x`, `mock-y`',
  );
  assert.equal(
    loopVariableDocumentationOf(loops[5], 'it'),
    '`it`: a loop variable of `unknown fn.loop`, bound to each item of its collection',
  );
  const topicBody = ['lambda', 'mock-fn', 'topics fn.loop', 'body', '${~topic}-topic', 'name'];
  const filedLoops = loops.map((loop) => ({ ...loop, file: '/repo/mock.yml' }));
  const enclosing = loopVariablesEnclosing(filedLoops, '/repo/mock.yml', topicBody);
  assert.deepEqual(enclosing.map(({ name, loop }) => [name, loop.key]), [['topic', 'topics fn.loop']]);
});

test('a named loop lands its result under its name, a list body yielding a list, and a nameless one '
  + 'among the holding map\'s entries or as its value', () => {
  const { value, pathMap } = expandedValueOf(sigilDoc.value, sigilContext);
  assert.deepEqual(value.lambda['mock-fn'], {
    queue_names: ['mock-a-queue', 'mock-b-queue'],
    topics: { 'mock-a-topic': { name: 'mock-a' }, 'mock-b-topic': { name: 'mock-b' } },
    labels: { 'mock-x': 'one', 'mock-y': 'two' },
    environment: { 'mock-a_TOPIC': 'mock-a-topic', LOG_LEVEL: 'info' },
    'flattened fn.flatten': ['local.it-mock-a'],
    unknown: ['~it.label'],
  });
  const topicName = ['lambda', 'mock-fn', 'topics fn.loop', 'body', '${~topic}-topic', 'name'];
  assert.deepEqual(expandedPathOf(pathMap, topicName), ['lambda', 'mock-fn', 'topics', 'mock-a-topic', 'name']);
  const problems = sourceProblemsOf([
    { path: ['lambda', 'mock-fn', 'queue_names', 1], message: 'mock second' },
    { path: ['lambda', 'mock-fn', 'topics'], message: 'mock whole' },
  ], pathMap);
  assert.deepEqual(problems.map((problem) => [problem.path, problem.message]), [
    [['lambda', 'mock-fn', 'queue_names fn.loop', 'body', 0], 'mock second (for `mock-b`)'],
    [['lambda', 'mock-fn', 'topics fn.loop'], 'mock whole'],
  ]);
});

test('a loop expanded in the tree lands under its name, '
  + 'and only the loop scope\'s rules read its loop variables', () => {
  const expanded = expandedTreeOf(sigilDoc.tree, sigilContext);
  const mockFn = expanded.entries[1].value.entries[0].value;
  assert.deepEqual(mockFn.entries.map((entry) => entry.key), [
    'queue_names',
    'topics',
    'labels',
    'environment',
    'flattened fn.flatten',
    'unknown',
  ]);
  assert.deepEqual(mockFn.entries[0].value.items.map((item) => item.value), ['mock-a-queue', 'mock-b-queue']);
  assert.deepEqual(mockFn.entries[4].value.kind, 'seq');
  assert.deepEqual(mockFn.entries[4].value.items.map((item) => item.value), ['local.it-mock-a']);
  const unscoped = loopContextOf({ ...sigilDsl, loops: null }, sigilTable);
  const { value } = expandedValueOf(sigilDoc.value, unscoped);
  assert.deepEqual(value.lambda['mock-fn'].queue_names, ['${~it}-queue', '${~it}-queue']);
});

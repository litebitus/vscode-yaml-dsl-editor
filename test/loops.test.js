const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../lib/config');
const { analyzeDocument } = require('../lib/analyze');
const { collectSymbols } = require('../lib/symbols');
const {
  loopContextOf,
  loopsOf,
  loopIdentifierAt,
  expandedTreeOf,
  expandedValueOf,
  expandedPathOf,
  sourceProblemsOf,
} = require('../lib/loops');
const { configText, dslEntry, scope, declaration, reference } = require('./config-builders');

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
    macro: { kind: 'loop', nameSuffixPattern: '::[A-Za-z0-9]+', unmarkedKeyPaths: [] },
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

test('a loop is a call of a loop macro, with its identifier, its literal items and its body path', () => {
  const loops = loopsOf(doc.tree, context);
  assert.deepEqual(loops.map((loop) => [loop.key, loop.holdingPath, loop.bodyPath, loop.identifier, loop.items]), [
    ['Fn::ForEach::Topics', ['Resources'], ['Resources', 'Fn::ForEach::Topics', 2], 'TopicName', ['MockA', 'MockB']],
    [
      'Fn::ForEach::Queues',
      ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}'],
      ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}', 'Fn::ForEach::Queues', 2],
      'QueueName',
      ['One'],
    ],
    ['Fn::ForEach::Unknown', ['Resources'], ['Resources', 'Fn::ForEach::Unknown', 2], 'ItemName', null],
  ]);
  assert.equal(loops[1].enclosing, loops[0]);
  assert.deepEqual(loops[0].identifierRange.start, { line: 2, character: 6 });
  assert.deepEqual(loopsOf(doc.tree, loopContextOf(dsl, {})), []);
});

test('a name inside a loop\'s body that is its identifier is the innermost loop\'s', () => {
  const loops = loopsOf(doc.tree, context);
  const queueBody = ['Resources', 'Fn::ForEach::Topics', 2, 'Topic${TopicName}', 'Fn::ForEach::Queues', 2, 'x'];
  assert.equal(loopIdentifierAt(loops, queueBody, 'TopicName'), loops[0]);
  assert.equal(loopIdentifierAt(loops, queueBody, 'QueueName'), loops[1]);
  assert.equal(loopIdentifierAt(loops, ['Resources', 'MockBucket'], 'TopicName'), null);
  assert.equal(loopIdentifierAt(loops, queueBody, 'MockBucket'), null);
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

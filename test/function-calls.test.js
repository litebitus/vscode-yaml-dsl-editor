const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const { analyzeDocument } = require('../lib/analyze');
const { completionsAt } = require('../lib/completion-offers');
const { parseAt } = require('../lib/document-path');
const {
  ARGUMENT_TYPES,
  parseFunctionKey,
  terraformVocabulary,
  schemaVocabulary,
  signatureText,
  functionDocumentationOf,
  callProblems,
  unmarkedCallsOf,
  calleeNamesOf,
  calleeWrittenAt,
} = require('../lib/function-calls');

const markerFunction = { callMarker: 'fn.', splatOperator: '*', callsWithoutNameAllowed: true };

const functionConfig = {
  definitions: [],
  callResultReferencePositions: ['whole_scalar'],
  callsNotAllowedAt: [
    { path: '$.*', tokens: parseAt('$.*'), skipKeys: [], includesSubtree: false },
    { path: '$.cloud', tokens: parseAt('$.cloud'), skipKeys: [], includesSubtree: false },
    { path: '$.cloud..*', tokens: parseAt('$.cloud..*'), skipKeys: [], includesSubtree: false },
  ],
  markerFunction,
};

function mockArgument(name, type, required, repeated) {
  return { name, type, required, repeated, description: `The mock ${name}.` };
}

function mockFunction(name, ...functionArguments) {
  return { description: `Mock ${name} function.`, arguments: functionArguments };
}

const table = {
  format: {
    ...mockFunction(
      'format',
      mockArgument('layout', 'text', true, false),
      mockArgument('operands', 'any', false, true),
    ),
    return: { type: 'text', description: 'The mock formatted text.' },
  },
  range: mockFunction(
    'range',
    mockArgument('start', 'whole_number', true, false),
    mockArgument('stop', 'whole_number', true, false),
    mockArgument('step', 'whole_number', true, false),
  ),
  ssm: mockFunction('ssm', mockArgument('parameter', 'text', true, false)),
  toggle: mockFunction(
    'toggle',
    mockArgument('flag', 'boolean', true, false),
    mockArgument('ratio', 'number', false, false),
  ),
  shape: mockFunction(
    'shape',
    mockArgument('items', 'list', true, false),
    mockArgument('fields', 'map', true, false),
  ),
};

const isExpression = (text, isKey) => (
  isKey ? text.startsWith('fn.') : text.startsWith('${') || text.startsWith('ref ')
);

function problemsFor(text, vocabulary = { table, complete: true }, config = functionConfig) {
  const dsl = { function: config, scopes: {}, declarations: [], references: [], placeholder: null };
  const doc = analyzeDocument(text, '/repo/mock.yml', dsl);
  return callProblems(doc.calls, config, vocabulary, isExpression).map((problem) => problem.message);
}

test('a key carries a call as a name and the marker, or the marker alone', () => {
  assert.deepEqual(parseFunctionKey('user fn.format*', markerFunction), {
    name: 'user',
    functionName: 'format',
    splat: true,
    markerStart: 5,
    nameStart: 8,
    nameEnd: 14,
    callEnd: 15,
  });
  assert.equal(parseFunctionKey('fn.values', markerFunction).name, null);
  assert.equal(parseFunctionKey('/etc/a.conf fn.templatefile*', markerFunction).name, '/etc/a.conf');
  assert.equal(parseFunctionKey('plain', markerFunction), null);
  assert.equal(parseFunctionKey('bad fn.1x', markerFunction), null);
  assert.equal(parseFunctionKey('x fn.ssm', null), null);
  assert.equal(parseFunctionKey(3, markerFunction), null);
});

test('calls are checked for name, arity, argument types, placement and unnamed form', () => {
  const text = [
    'locals:',
    '  a fn.ssm: /mock/key',
    '  b fn.range*: [1, 3, 1]',
    '  c fn.range*: [1, 3]',
    '  d fn.range*: 5',
    '  e fn.nope: x',
    '  f fn.format*: ["%s-%s", one, two]',
    '  g fn.range*: [1, "two", 3]',
    '  h fn.ssm: ${local.parameter}',
    '  i fn.toggle*: [true, 0.5]',
    '  j fn.toggle*: [1, oops]',
    '  k fn.shape*: [[1], { a: 1 }]',
    '  l fn.shape*: [{ fn.format*: ["%s", x] }, { b: 1 }]',
    '  m fn.shape*: [x, [1]]',
    '  n:',
    '    fn.ssm: /mock/key',
    '    other: 1',
    '  o:',
    '    - fn.ssm: /mock/key',
    'top fn.ssm: x',
    'cloud:',
    '  deep:',
    '    p fn.ssm: x',
    '',
  ].join('\n');
  assert.deepEqual(problemsFor(text), [
    'range takes 3 arguments, given 2',
    'range with the splat operator needs a list of arguments',
    'unknown function nope',
    'range argument stop expects whole_number',
    'toggle argument flag expects boolean',
    'toggle argument ratio expects number',
    'shape argument items expects list',
    'shape argument fields expects map',
    'a call with no name must be the only key of its map',
    'a function call is not allowed at this key',
    'a function call is not allowed at this key',
  ]);
  const refusing = { ...functionConfig, markerFunction: { ...markerFunction, callsWithoutNameAllowed: false } };
  const refused = problemsFor('x:\n  - fn.ssm: /mock/key\n', { table, complete: true }, refusing);
  assert.deepEqual(refused, ['a function call needs a name before it']);
  assert.deepEqual(problemsFor('x:\n  y fn.nope: 1\n', { table: {}, complete: false }), []);
});

test('with no splat operator, the function table decides how a call value binds its arguments', () => {
  const tableMarker = { callMarker: 'Fn::', splatOperator: null, callsWithoutNameAllowed: true };
  const tableConfig = { ...functionConfig, callsNotAllowedAt: [], markerFunction: tableMarker };
  const byTable = {
    Length: mockFunction('Length', mockArgument('items', 'list', true, false)),
    Join: mockFunction(
      'Join',
      mockArgument('delimiter', 'text', true, false),
      mockArgument('values', 'list', true, false),
    ),
    Sub: mockFunction(
      'Sub',
      mockArgument('template', 'text', true, false),
      mockArgument('variables', 'map', false, false),
    ),
  };
  assert.equal(parseFunctionKey('Fn::Join*', tableMarker), null);
  assert.equal(parseFunctionKey('Fn::Join', tableMarker).splat, false);
  const text = [
    'whole:',
    '  Fn::Length: [1, 2, 3]',
    'listed:',
    '  Fn::Join: [",", [x, y]]',
    'first:',
    '  Fn::Sub: mock-text',
    'both:',
    '  Fn::Sub: [mock-text, { x: 1 }]',
    'extra:',
    '  Fn::Join: [",", [x], mock-extra]',
    'scalar_for_list:',
    '  Fn::Length: mock-text',
    'one_of_two:',
    '  Fn::Join: mock-text',
    '',
  ].join('\n');
  assert.deepEqual(problemsFor(text, { table: byTable, complete: true }, tableConfig), [
    'Join takes 2 arguments, given 3',
    'Length argument items expects list',
    'Join takes 2 arguments, given 1',
  ]);
});

const loopMacro = {
  ...mockFunction(
    'ForEach',
    mockArgument('identifier', 'text', true, false),
    mockArgument('collection', 'list', true, false),
    mockArgument('fragment', 'map', true, false),
  ),
  macro: { kind: 'loop', nameSuffixPattern: '::[A-Za-z0-9]+', unmarkedKeyPaths: [] },
};

test('a macro call stands as a whole key among siblings, kept distinct by its name suffix', () => {
  const tableMarker = { callMarker: 'Fn::', splatOperator: null, callsWithoutNameAllowed: true };
  const tableConfig = { ...functionConfig, callsNotAllowedAt: [], markerFunction: tableMarker };
  const withMacro = {
    ForEach: loopMacro,
    Join: mockFunction(
      'Join',
      mockArgument('delimiter', 'text', true, false),
      mockArgument('values', 'list', true, false),
    ),
  };
  const problemsWith = (written, vocabularyTable, config = tableConfig) => (
    problemsFor(written, { table: vocabularyTable, complete: true }, config)
  );
  const text = [
    'Resources:',
    '  Fn::ForEach::Topics:',
    '    - TopicName',
    '    - [MockA, MockB]',
    '    - Topic${TopicName}:',
    '        Type: mock-type',
    '  Fn::ForEach::Queues: [QueueName, [MockC], { "Queue${QueueName}": { Type: mock-type } }]',
    '  MockBucket:',
    '    Type: mock-type',
    'unsuffixed:',
    '  Fn::ForEachMock: [x, [1], {}]',
    '  other: 1',
    'short:',
    '  Fn::ForEach::Items: [x, [1]]',
    'beside:',
    '  Fn::Join: [",", [x]]',
    '  other: 1',
    '',
  ].join('\n');
  assert.deepEqual(problemsWith(text, withMacro), [
    'a call with no name must be the only key of its map',
    'ForEach takes 3 arguments, given 2',
    'a call with no name must be the only key of its map',
  ]);
  const suffixed = 'x:\n  Fn::ForEach::Topics: [x, [1], {}]\n';
  assert.deepEqual(problemsWith('x:\n  Fn::ForEachMock: [x, [1], {}]\n', withMacro), ['unknown function ForEachMock']);
  assert.deepEqual(problemsWith('x:\n  Fn::ForEach: [x, [1], {}]\n', withMacro), ['unknown function ForEach']);
  const unsuffixedMacro = { ForEach: { ...loopMacro, macro: { kind: 'loop', nameSuffixPattern: null } } };
  assert.deepEqual(problemsWith(suffixed, unsuffixedMacro), ['unknown function ForEach::Topics']);
  const refusing = { ...tableConfig, markerFunction: { ...tableMarker, callsWithoutNameAllowed: false } };
  assert.deepEqual(problemsWith(suffixed, withMacro, refusing), []);
});

test('a function_call macro binds its arguments by name, or takes the callee\'s name alone or a list of calls, '
  + 'and binds the callee\'s arguments by name', () => {
  const tableMarker = { callMarker: 'Fn::', splatOperator: null, callsWithoutNameAllowed: true };
  const tableConfig = { ...functionConfig, callsNotAllowedAt: [], markerFunction: tableMarker };
  const functionCallTable = {
    Transform: {
      ...mockFunction(
        'Transform',
        mockArgument('Name', 'text', true, false),
        mockArgument('Parameters', 'map', false, false),
      ),
      macro: { kind: 'function_call', nameSuffixPattern: null, unmarkedKeyPaths: [] },
    },
    'Mock::Include': {
      ...mockFunction('Mock::Include', mockArgument('Location', 'text', true, false)),
      macro: { kind: 'merge', nameSuffixPattern: null, unmarkedKeyPaths: [] },
    },
  };
  const text = [
    'Resources:',
    '  Fn::Transform:',
    '    Name: Mock::Include',
    '    Parameters: { Location: s3://mock-bucket/mock.yaml }',
    '  MockBucket:',
    '    Fn::Transform: { Name: Mock::Registered, Extra: 1 }',
    '    Other: x',
    '  MockQueue:',
    '    Fn::Transform: { Parameters: {} }',
    '  MockTopic:',
    '    Fn::Transform:',
    '      Name: Mock::Include',
    '      Parameters: { Location: [1], Unknown: x }',
    '  MockList:',
    '    Fn::Transform: [Mock::Registered, Mock::Include, 3]',
    '  MockEmpty:',
    '    Fn::Transform:',
    '',
  ].join('\n');
  assert.deepEqual(problemsFor(text, { table: functionCallTable, complete: true }, tableConfig), [
    'Transform has no argument Extra',
    'Transform needs argument Name',
    'Mock::Include has no argument Unknown',
    'Mock::Include argument Location expects text',
    'Mock::Include needs argument Location',
    'Transform argument Name expects text',
    'Transform needs argument Name',
  ]);
});

test('a function_call macro\'s callee is written after its callee key, as the call\'s value or as a list item', () => {
  const tableMarker = { callMarker: 'Fn::', splatOperator: null, callsWithoutNameAllowed: true };
  const dsl = {
    function: { ...functionConfig, callsNotAllowedAt: [], markerFunction: tableMarker },
    scopes: {},
    declarations: [],
    references: [],
    placeholder: null,
  };
  const transform = {
    ...mockFunction('Transform', mockArgument('Name', 'text', true, false)),
    macro: { kind: 'function_call', nameSuffixPattern: null, unmarkedKeyPaths: [] },
  };
  const text = [
    'Resources:',
    '  Fn::Transform:',
    '    Name: Mock::Include',
    '    Other: x',
    '  MockQueue:',
    '    Fn::Transform: Mock::Macro',
    '  MockList:',
    '    Fn::Transform: [Mock::Macro]',
    '',
  ].join('\n');
  const doc = analyzeDocument(text, '/repo/mock.yml', dsl);
  const writtenAt = (line, character) => doc.calls
    .filter((call) => calleeWrittenAt(call, transform, { line, character }));
  assert.equal(writtenAt(2, 10).length, 1);
  assert.equal(writtenAt(2, 4).length, 0);
  assert.equal(writtenAt(3, 11).length, 0);
  assert.equal(writtenAt(5, 20).length, 1);
  assert.equal(writtenAt(7, 21).length, 1);
});

test('a callee completion offers the table entries of the callee\'s type, replacing the whole name typed', () => {
  const stack = {
    dsl: { references: [], placeholder: null, function: null },
    symbols: [],
    vocabulary: {
      table: {
        'mock:include': {
          ...mockFunction('mock:include', mockArgument('Location', 'text', true, false)),
          macro: { kind: 'merge', nameSuffixPattern: null, unmarkedKeyPaths: [] },
        },
        'mock:join': mockFunction('mock:join'),
      },
    },
  };
  const offeredAt = (lineText, calleeType) => {
    const position = { line: 0, character: lineText.length };
    const site = { file: null, documentPath: [], calleeType };
    return completionsAt(lineText, position, site, stack, null)
      .map((item) => [item.label, item.range.start.character]);
  };
  assert.deepEqual(offeredAt('    Name: mock:inc', 'macro'), [['mock:include', 10]]);
  assert.deepEqual(offeredAt('    Name: ', 'macro'), [['mock:include', 10]]);
  assert.deepEqual(offeredAt('  Fn::Transform: [mock:a,mock:in', 'macro'), [['mock:include', 25]]);
  assert.deepEqual(offeredAt('    Name: ', 'function'), [['mock:join', 10]]);
  assert.deepEqual(offeredAt('    Name: ', 'text'), []);
});

test('a function_call macro\'s callee typed macro or function names a table entry of that kind', () => {
  const tableMarker = { callMarker: 'Fn::', splatOperator: null, callsWithoutNameAllowed: true };
  const tableConfig = { ...functionConfig, callsNotAllowedAt: [], markerFunction: tableMarker };
  const macroCallee = {
    Transform: {
      ...mockFunction('Transform', mockArgument('Name', 'macro', true, false)),
      macro: { kind: 'function_call', nameSuffixPattern: null, unmarkedKeyPaths: [] },
    },
    'Mock::Include': {
      ...mockFunction('Mock::Include'),
      macro: { kind: 'merge', nameSuffixPattern: null, unmarkedKeyPaths: [] },
    },
    Join: mockFunction('Join'),
  };
  const problemsWith = (text) => problemsFor(text, { table: macroCallee, complete: true }, tableConfig);
  assert.deepEqual(problemsWith('x:\n  Fn::Transform:\n    Name: Mock::Include\n'), []);
  assert.deepEqual(problemsWith('x:\n  Fn::Transform:\n    Name: Mock::Registered\n'), []);
  assert.deepEqual(problemsWith('x:\n  Fn::Transform:\n    Name: Join\n'), ['Transform argument Name expects macro']);
  assert.deepEqual(problemsWith('x:\n  Fn::Transform: Join\n'), ['Transform argument Name expects macro']);
});

test('a key at a macro\'s unmarked key path calls the macro without the call marker', () => {
  const tableMarker = { callMarker: 'Fn::', splatOperator: null, callsWithoutNameAllowed: true };
  const dsl = {
    function: { ...functionConfig, callsNotAllowedAt: [], markerFunction: tableMarker },
    scopes: {},
    declarations: [],
    references: [],
    placeholder: null,
  };
  const transform = {
    ...mockFunction('Transform', mockArgument('Name', 'text', true, false)),
    macro: { kind: 'function_call', nameSuffixPattern: null, unmarkedKeyPaths: [parseAt('$.Transform')] },
  };
  const doc = analyzeDocument('Transform: Mock::Macro\nResources:\n  Transform: x\n', '/repo/mock.yml', dsl);
  const calls = unmarkedCallsOf(doc.tree, { Transform: transform, ssm: table.ssm });
  assert.deepEqual(calls.map((call) => [call.functionName, call.documentPath, call.keyRange.start.line]), [
    ['Transform', ['Transform'], 0],
  ]);
  assert.deepEqual(unmarkedCallsOf(doc.tree, { ssm: { ...table.ssm, macro: null } }), []);
  assert.deepEqual(calleeNamesOf(calls[0], transform), [
    { name: 'Mock::Macro', range: doc.tree.entries[0].value.range },
  ]);
});

test('a macro is a table entry with a macro object, taking no return, its arguments fitting its kind', () => {
  const published = (entry) => schemaVocabulary({ x: { f: entry } }, '#/x');
  const loopEntry = {
    ...mockFunction(
      'f',
      mockArgument('identifier', 'text', true, false),
      mockArgument('collection', 'list', true, false),
      mockArgument('fragment', 'map', true, false),
    ),
    macro: { kind: 'loop', name_suffix_pattern: '::[A-Za-z0-9]+' },
  };
  assert.deepEqual(published(loopEntry).vocabulary.f.macro, {
    kind: 'loop',
    nameSuffixPattern: '::[A-Za-z0-9]+',
    unmarkedKeyPaths: [],
  });
  const unsuffixed = { ...loopEntry, macro: { kind: 'loop', unmarked_key_paths: ['$.Mock'] } };
  assert.deepEqual(published(unsuffixed).vocabulary.f.macro, {
    kind: 'loop',
    nameSuffixPattern: null,
    unmarkedKeyPaths: [[{ kind: 'name', key: 'Mock' }]],
  });
  for (const keyPaths of ['$.Mock', ['$'], ['mock'], [1]]) {
    assert.equal(
      published({ ...loopEntry, macro: { kind: 'loop', unmarked_key_paths: keyPaths } }).problem,
      '#/x f.macro.unmarked_key_paths must be a list of JSONPaths',
    );
  }
  assert.equal(published({ ...loopEntry, macro: 1 }).problem, '#/x f.macro must be a mapping with kind');
  assert.equal(
    published({ ...loopEntry, macro: { kind: 'mock-kind' } }).problem,
    '#/x f.macro.kind must be one of function_call, merge, loop, transform',
  );
  assert.equal(
    published({ ...loopEntry, macro: { kind: 'loop', name_suffix_pattern: '(' } }).problem,
    '#/x f.macro.name_suffix_pattern must be a regular expression',
  );
  assert.equal(
    published({ ...loopEntry, return: { type: 'map', description: 'The mock expansion.' } }).problem,
    '#/x f is a macro, so it takes no return',
  );
  const withArguments = (kind, ...functionArguments) => ({
    ...mockFunction('f', ...functionArguments),
    macro: { kind },
  });
  const textArgument = (name) => mockArgument(name, 'text', true, false);
  const fitting = [
    withArguments('function_call', textArgument('Name'), mockArgument('Parameters', 'map', false, false)),
    withArguments('function_call', textArgument('Name')),
    withArguments('merge', textArgument('Location')),
    withArguments('merge', mockArgument('content', 'map', true, false)),
    withArguments(
      'loop',
      mockArgument('identifier', 'any', true, false),
      mockArgument('items', 'any', true, false),
      mockArgument('body', 'any', true, false),
    ),
    withArguments('transform'),
    withArguments('transform', textArgument('Location'), mockArgument('Options', 'map', false, false)),
  ];
  for (const entry of fitting) assert.equal(published(entry).problem, null, entry.macro.kind);
  const unfitting = [
    [
      withArguments('function_call', mockArgument('Name', 'map', true, false)),
      "the callee's name (text, function or macro), then the callee's arguments (map)",
    ],
    [withArguments('transform', mockArgument('Options', 'map', true, true)), 'its own, by name'],
    [
      withArguments('merge', mockArgument('Location', 'list', true, false)),
      "the content's location (text) or the content (map)",
    ],
    [
      withArguments('merge', mockArgument('items', 'text', true, true)),
      "the content's location (text) or the content (map)",
    ],
    [
      withArguments('loop', textArgument('identifier')),
      'the identifier (text), the collection (list), the body (map)',
    ],
  ];
  for (const [entry, wording] of unfitting) {
    assert.equal(published(entry).problem, `#/x f is a ${entry.macro.kind} macro, whose arguments are ${wording}`);
  }
});

test('a macro is documented by its signature after macro, its arguments and what it expands to', () => {
  const signature = 'macro ForEach(identifier: text, collection: list, fragment: map)';
  assert.equal(signatureText('ForEach', loopMacro), signature);
  assert.equal(functionDocumentationOf('ForEach', loopMacro), [
    `\`\`\`yaml-dsl-signature\n${signature}\n\`\`\``,
    'Mock ForEach function.',
    '- `identifier`: The mock identifier.\n- `collection`: The mock collection.\n- `fragment`: The mock fragment.',
    '*Expands to:* `fragment` once per item of `collection`, the item standing for `identifier`.',
  ].join('\n\n'));
  const expansionOf = (kind, ...typedNames) => {
    const entry = {
      description: null,
      arguments: typedNames.map(([name, type]) => ({ name, type, required: true, repeated: false, description: null })),
      return: null,
      macro: { kind, nameSuffixPattern: null },
    };
    return functionDocumentationOf('f', entry).split('\n\n').pop();
  };
  assert.equal(
    expansionOf('function_call', ['Name', 'text'], ['Parameters', 'map']),
    '*Expands to:* a call of the macro or function `Name` names, `Parameters` its arguments by name.',
  );
  assert.equal(
    expansionOf('function_call', ['Name', 'text']),
    '*Expands to:* a call of the macro or function `Name` names.',
  );
  assert.equal(
    expansionOf('merge', ['Location', 'text']),
    '*Expands to:* the map holding the call, merged over the content at `Location`.',
  );
  assert.equal(
    expansionOf('merge', ['content', 'map']),
    '*Expands to:* the map holding the call, merged over `content`.',
  );
  assert.equal(expansionOf('transform'), '*Expands to:* the map holding the call, rewritten by the macro.');
  const transformEntry = { description: 'Mock transform.', arguments: [], macro: { kind: 'transform', nameSuffixPattern: null } };
  assert.equal(signatureText('Mock::Transform', transformEntry), 'macro Mock::Transform()');
});

test("Terraform's function metadata becomes a vocabulary", () => {
  const vocabulary = terraformVocabulary({
    function_signatures: {
      join: {
        description: 'Mock join.',
        return_type: 'string',
        parameters: [{ name: 'separator', type: 'string', description: 'The mock separator.' }],
        variadic_parameter: { name: 'lists', type: ['list', 'string'], description: 'The mock lists.' },
      },
      jsonencode: { parameters: [{ name: 'val', type: 'dynamic' }] },
      max: { variadic_parameter: { name: 'numbers', type: 'number' } },
      lookup: { parameters: [{ name: 'inputMap', type: ['map', 'dynamic'] }, { name: 'flag', type: 'bool' }] },
      tuplefn: { parameters: [{ name: 'items', type: ['tuple', ['string']] }, { name: 'obj', type: ['object', {}] }] },
      setfn: { parameters: [{ name: 'items', type: ['set', 'string'] }] },
    },
  });
  assert.deepEqual(vocabulary.join, {
    description: 'Mock join.',
    arguments: [
      { name: 'separator', type: 'text', required: true, repeated: false, description: 'The mock separator.' },
      { name: 'lists', type: 'list', required: false, repeated: true, description: 'The mock lists.' },
    ],
    return: { type: 'text', description: null },
    macro: null,
  });
  const argumentTypesOf = (functionName) => vocabulary[functionName].arguments.map((parameter) => parameter.type);
  assert.deepEqual(argumentTypesOf('jsonencode'), ['any']);
  assert.deepEqual(vocabulary.max, {
    description: null,
    arguments: [{ name: 'numbers', type: 'number', required: false, repeated: true, description: null }],
    return: null,
    macro: null,
  });
  assert.deepEqual(argumentTypesOf('lookup'), ['map', 'boolean']);
  assert.deepEqual(argumentTypesOf('tuplefn'), ['list', 'map']);
  assert.deepEqual(argumentTypesOf('setfn'), ['list']);
  assert.equal(terraformVocabulary(null), null);
  assert.equal(terraformVocabulary({ format_version: '1.0' }), null);
});

test('a schema publishes a function table at a pointer, held to the documented format', () => {
  const schema = { 'x-yaml-dsl-functions': table, 'x-a~b/c': { ssm: table.ssm } };
  const readTable = Object.fromEntries(Object.entries(table)
    .map(([functionName, entry]) => [functionName, { ...entry, return: entry.return || null, macro: null }]));
  assert.deepEqual(schemaVocabulary(schema, '#/x-yaml-dsl-functions').vocabulary, readTable);
  assert.deepEqual(schemaVocabulary(schema, '#/x-a~0b~1c').vocabulary, { ssm: readTable.ssm });
  assert.deepEqual(schemaVocabulary(null, '#/x'), { vocabulary: null, problem: null, notice: null });
  assert.equal(schemaVocabulary(schema, '#/x-yaml-dsl-functions').notice, null);
  assert.equal(schemaVocabulary(schema, '#/missing').problem, 'the schema publishes no #/missing');
  assert.equal(
    schemaVocabulary({ x: { deep: 1 } }, '#/x/deep/further').problem,
    'the schema publishes no #/x/deep/further',
  );
  const malformed = (published) => schemaVocabulary({ x: published }, '#/x').problem;
  const argument = (name, required, repeated) => mockArgument(name, 'text', required, repeated);
  const withArguments = (...functionArguments) => ({ f: mockFunction('f', ...functionArguments) });
  assert.equal(malformed([]), '#/x is not a mapping of function names');
  assert.equal(malformed({ 'a.b': mockFunction('a.b') }), '#/x a.b is not a function name');
  assert.equal(malformed({ 'Mock::Macro-2020-07-23': mockFunction('Mock::Macro-2020-07-23') }), null);
  assert.equal(malformed({ f: 1 }), '#/x f must be a mapping with description and arguments');
  assert.equal(malformed({ f: { description: 'Mock f.' } }), '#/x f must be a mapping with description and arguments');
  assert.equal(malformed({ f: { arguments: [] } }), '#/x f.description is required');
  assert.equal(malformed(withArguments({})), '#/x f.arguments[0].name is required');
  assert.equal(malformed(withArguments({ name: '' })), '#/x f.arguments[0].name is required');
  assert.equal(
    malformed(withArguments({ name: 'a', type: 'mock-type' })),
    '#/x f.arguments[0].type must be one of text, number, whole_number, boolean, list, map, function, macro, any',
  );
  assert.equal(malformed(withArguments({ name: 'a', type: 'text' })), '#/x f.arguments[0].required must be true or false');
  assert.equal(
    malformed(withArguments({ name: 'a', type: 'text', required: true })),
    '#/x f.arguments[0].repeated must be true or false',
  );
  assert.equal(
    malformed(withArguments({ name: 'a', type: 'text', required: true, repeated: false })),
    '#/x f.arguments[0].description is required',
  );
  assert.equal(
    malformed(withArguments(argument('a', false, true), argument('b', false, false))),
    '#/x f.arguments[0] repeats but is not the last argument',
  );
  assert.equal(
    malformed(withArguments(argument('a', false, false), argument('b', true, false))),
    '#/x f.arguments[1] is required after an optional argument',
  );
  const withReturn = (returned) => ({ f: { ...mockFunction('f'), return: returned } });
  assert.equal(malformed(withReturn('text')), '#/x f.return must be a mapping with type and description');
  assert.equal(
    malformed(withReturn({ type: 'mock-type' })),
    '#/x f.return.type must be one of text, number, whole_number, boolean, list, map, function, macro, any',
  );
  assert.equal(malformed(withReturn({ type: 'text' })), '#/x f.return.description is required');
});

test('a function mapped straight to its argument list is still read, with no description, and noted as deprecated', () => {
  const listed = [
    { name: 'layout', type: 'text', required: true, repeated: false },
    { name: 'operands', type: 'any', required: false, repeated: true },
  ];
  assert.equal(
    schemaVocabulary({ x: { format: listed, ssm: table.ssm } }, '#/x').notice,
    '#/x maps a function straight to its arguments, a deprecated form: '
      + 'map each function to its description, arguments and return',
  );
  assert.deepEqual(schemaVocabulary({ x: { format: listed } }, '#/x').vocabulary, {
    format: {
      description: null,
      arguments: listed.map((parameter) => ({ ...parameter, description: null })),
      return: null,
      macro: null,
    },
  });
  assert.equal(
    schemaVocabulary({ x: { format: [{ name: 'a', type: 'text' }] } }, '#/x').problem,
    '#/x format[0].required must be true or false',
  );
});

test('the shipped schema of the table is a draft 2020-12 schema stating the argument types the editor checks', () => {
  const shipped = require('../schemas/x-yaml-dsl-functions.schema.json');
  assert.equal(shipped.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const validate = new Ajv2020({ strict: false, strictSchema: true }).compile(shipped);
  assert.deepEqual(shipped.$defs.valueType.enum, ARGUMENT_TYPES);
  assert.equal(validate(table), true, JSON.stringify(validate.errors));
  assert.equal(validate({ format: [{ name: 'layout', type: 'text', required: true, repeated: false }] }), true);
  assert.equal(validate({ format: { arguments: [] } }), false);
  assert.equal(validate({ format: { ...table.format, return: { type: 'text' } } }), false);
  const loopEntry = { ...loopMacro, macro: { kind: 'loop', name_suffix_pattern: '::[A-Za-z0-9]+' } };
  assert.equal(validate({ ForEach: loopEntry }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ForEach: { ...loopEntry, macro: { kind: 'mock-kind' } } }), false);
  const returned = { type: 'map', description: 'The mock expansion.' };
  assert.equal(validate({ ForEach: { ...loopEntry, return: returned } }), false);
});

test('a signature names each argument, its type, whether it is optional or repeated, and what it returns', () => {
  assert.equal(signatureText('format', table.format), 'format(layout: text, ...operands?: any): text');
  assert.equal(signatureText('toggle', table.toggle), 'toggle(flag: boolean, ratio?: number): void');
});

test('a function is documented by its signature, its description, each described argument and its return', () => {
  assert.equal(functionDocumentationOf('format', table.format), [
    '```yaml-dsl-signature\nformat(layout: text, ...operands?: any): text\n```',
    'Mock format function.',
    '- `layout`: The mock layout.\n- `operands`: The mock operands.',
    '*Returns:* The mock formatted text.',
  ].join('\n\n'));
  const undescribed = { description: null, arguments: [{ ...table.ssm.arguments[0], description: null }], return: null };
  assert.equal(
    functionDocumentationOf('ssm', undescribed),
    '```yaml-dsl-signature\nssm(parameter: text): void\n```\n\n*Returns:* `void`',
  );
  const typedOnly = { ...undescribed, return: { type: 'text', description: null } };
  assert.equal(
    functionDocumentationOf('ssm', typedOnly),
    '```yaml-dsl-signature\nssm(parameter: text): text\n```\n\n*Returns:* `text`',
  );
});

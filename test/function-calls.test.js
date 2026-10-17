const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const { analyzeDocument } = require('../lib/analyze');
const { parseAt } = require('../lib/document-path');
const {
  ARGUMENT_TYPES,
  parseFunctionKey,
  terraformVocabulary,
  schemaVocabulary,
  signatureText,
  functionDocumentationOf,
  callProblems,
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
  });
  const argumentTypesOf = (functionName) => vocabulary[functionName].arguments.map((parameter) => parameter.type);
  assert.deepEqual(argumentTypesOf('jsonencode'), ['any']);
  assert.deepEqual(vocabulary.max, {
    description: null,
    arguments: [{ name: 'numbers', type: 'number', required: false, repeated: true, description: null }],
    return: null,
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
    .map(([functionName, entry]) => [functionName, { ...entry, return: entry.return || null }]));
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
  assert.equal(malformed({ 'a-b': mockFunction('a-b') }), '#/x a-b is not a function name');
  assert.equal(malformed({ f: 1 }), '#/x f must be a mapping with description and arguments');
  assert.equal(malformed({ f: { description: 'Mock f.' } }), '#/x f must be a mapping with description and arguments');
  assert.equal(malformed({ f: { arguments: [] } }), '#/x f.description is required');
  assert.equal(malformed(withArguments({})), '#/x f.arguments[0].name is required');
  assert.equal(malformed(withArguments({ name: '' })), '#/x f.arguments[0].name is required');
  assert.equal(
    malformed(withArguments({ name: 'a', type: 'mock-type' })),
    '#/x f.arguments[0].type must be one of text, number, whole_number, boolean, list, map, any',
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
    '#/x f.return.type must be one of text, number, whole_number, boolean, list, map, any',
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
});

test('a signature names each argument, its type, whether it is optional or repeated, and what it returns', () => {
  assert.equal(signatureText('format', table.format), 'format(layout: text, ...operands?: any): text');
  assert.equal(signatureText('toggle', table.toggle), 'toggle(flag: boolean, ratio?: number): void');
});

test('a function is documented by its signature, its description, each described argument and its return', () => {
  assert.equal(functionDocumentationOf('format', table.format), [
    '```\nformat(layout: text, ...operands?: any): text\n```',
    'Mock format function.',
    '- `layout`: The mock layout.\n- `operands`: The mock operands.',
    '*Returns:* The mock formatted text.',
  ].join('\n\n'));
  const undescribed = { description: null, arguments: [{ ...table.ssm.arguments[0], description: null }], return: null };
  assert.equal(functionDocumentationOf('ssm', undescribed), '```\nssm(parameter: text): void\n```\n\n*Returns:* `void`');
  const typedOnly = { ...undescribed, return: { type: 'text', description: null } };
  assert.equal(functionDocumentationOf('ssm', typedOnly), '```\nssm(parameter: text): text\n```\n\n*Returns:* `text`');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');
const { parseAt } = require('../lib/document-path');
const {
  ARGUMENT_TYPES,
  parseFunctionKey,
  terraformVocabulary,
  schemaVocabulary,
  signatureText,
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

const table = {
  format: [
    { name: 'layout', type: 'text', required: true, repeated: false },
    { name: 'operands', type: 'any', required: false, repeated: true },
  ],
  range: [
    { name: 'start', type: 'whole_number', required: true, repeated: false },
    { name: 'stop', type: 'whole_number', required: true, repeated: false },
    { name: 'step', type: 'whole_number', required: true, repeated: false },
  ],
  ssm: [{ name: 'parameter', type: 'text', required: true, repeated: false }],
  toggle: [
    { name: 'flag', type: 'boolean', required: true, repeated: false },
    { name: 'ratio', type: 'number', required: false, repeated: false },
  ],
  shape: [
    { name: 'items', type: 'list', required: true, repeated: false },
    { name: 'fields', type: 'map', required: true, repeated: false },
  ],
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

test("Terraform's function metadata becomes a vocabulary", () => {
  const vocabulary = terraformVocabulary({
    function_signatures: {
      join: {
        parameters: [{ name: 'separator', type: 'string' }],
        variadic_parameter: { name: 'lists', type: ['list', 'string'] },
      },
      jsonencode: { parameters: [{ name: 'val', type: 'dynamic' }] },
      max: { variadic_parameter: { name: 'numbers', type: 'number' } },
      lookup: { parameters: [{ name: 'inputMap', type: ['map', 'dynamic'] }, { name: 'flag', type: 'bool' }] },
      tuplefn: { parameters: [{ name: 'items', type: ['tuple', ['string']] }, { name: 'obj', type: ['object', {}] }] },
      setfn: { parameters: [{ name: 'items', type: ['set', 'string'] }] },
    },
  });
  assert.deepEqual(vocabulary.join, [
    { name: 'separator', type: 'text', required: true, repeated: false },
    { name: 'lists', type: 'list', required: false, repeated: true },
  ]);
  assert.deepEqual(vocabulary.jsonencode[0].type, 'any');
  assert.deepEqual(vocabulary.max, [{ name: 'numbers', type: 'number', required: false, repeated: true }]);
  assert.deepEqual(vocabulary.lookup.map((parameter) => parameter.type), ['map', 'boolean']);
  assert.deepEqual(vocabulary.tuplefn.map((parameter) => parameter.type), ['list', 'map']);
  assert.deepEqual(vocabulary.setfn[0].type, 'list');
  assert.equal(terraformVocabulary(null), null);
  assert.equal(terraformVocabulary({ format_version: '1.0' }), null);
});

test('a schema publishes a function table at a pointer, held to the documented format', () => {
  const schema = { 'x-yaml-dsl-functions': table, 'x-a~b/c': { ssm: table.ssm } };
  assert.deepEqual(schemaVocabulary(schema, '#/x-yaml-dsl-functions').vocabulary, table);
  assert.deepEqual(schemaVocabulary(schema, '#/x-a~0b~1c').vocabulary, { ssm: table.ssm });
  assert.deepEqual(schemaVocabulary(null, '#/x'), { vocabulary: null, problem: null });
  assert.equal(schemaVocabulary(schema, '#/missing').problem, 'the schema publishes no #/missing');
  assert.equal(
    schemaVocabulary({ x: { deep: 1 } }, '#/x/deep/further').problem,
    'the schema publishes no #/x/deep/further',
  );
  const malformed = (published) => schemaVocabulary({ x: published }, '#/x').problem;
  const argument = (name, required, repeated) => ({ name, type: 'text', required, repeated });
  assert.equal(malformed([]), '#/x is not a mapping of function names');
  assert.equal(malformed({ 'a-b': [] }), '#/x a-b is not a function name');
  assert.equal(malformed({ f: 1 }), '#/x f is not a list of arguments');
  assert.equal(malformed({ f: [{}] }), '#/x f[0].name is required');
  assert.equal(malformed({ f: [{ name: '' }] }), '#/x f[0].name is required');
  assert.equal(
    malformed({ f: [{ name: 'a', type: 'mock-type' }] }),
    '#/x f[0].type must be one of text, number, whole_number, boolean, list, map, any',
  );
  assert.equal(malformed({ f: [{ name: 'a', type: 'text' }] }), '#/x f[0].required must be true or false');
  assert.equal(
    malformed({ f: [{ name: 'a', type: 'text', required: true }] }),
    '#/x f[0].repeated must be true or false',
  );
  assert.equal(
    malformed({ f: [argument('a', false, true), argument('b', false, false)] }),
    '#/x f[0] repeats but is not the last argument',
  );
  assert.equal(
    malformed({ f: [argument('a', false, false), argument('b', true, false)] }),
    '#/x f[1] is required after an optional argument',
  );
});

test('the shipped schema of the table states the argument types the editor checks', () => {
  const shipped = require('../schemas/x-yaml-dsl-functions.schema.json');
  assert.deepEqual(shipped.additionalProperties.items.properties.type.enum, ARGUMENT_TYPES);
});

test('a signature names each argument, its type, and whether it is optional or repeated', () => {
  assert.equal(signatureText('format', table.format), 'format(layout: text, ...operands?: any)');
  assert.equal(signatureText('toggle', table.toggle), 'toggle(flag: boolean, ratio?: number)');
});

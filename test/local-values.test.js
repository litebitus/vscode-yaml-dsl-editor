const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, hoverAt, analysisProblems } = require('../lib/analyze');
const { createLocalValues } = require('../lib/local-values');
const { substitutedName } = require('../lib/scope-resolution');
const {
  scope,
  declaration,
  reference,
  placeholder,
  markerFunction,
  dslEntry,
  parsedDsl,
} = require('./config-builders');

const inPlaceholders = ['whole_placeholder', 'placeholder_in_text'];

function localsDsl(fields = {}) {
  return parsedDsl(dslEntry('resource', {
    placeholder: placeholder(),
    function: markerFunction(),
    locals: { scope_name: 'local' },
    scopes: {
      GLOBAL: scope({ builtin_names: ['env'] }),
      local: scope(),
      RESOURCE: scope({ named_by_parent_key: true }),
    },
    declarations: [
      declaration('$.locals.*', 'local', { key_token: 'first_word' }),
      declaration('$.*.*', 'RESOURCE', { skip_keys: ['locals'], key_token: 'last_word' }),
    ],
    references: [
      reference('^local\\.(?<name>[a-z0-9_]+)$', 'local', { positions: ['whole_scalar', ...inPlaceholders] }),
      reference('^(?<name>[a-z_]+)$', 'GLOBAL', { positions: inPlaceholders }),
    ],
    ...fields,
  }));
}

const common = '/repo/mock.yml';
const overlay = '/repo/one/mock.yml';

function stackOf(dsl, texts, activeFile) {
  const files = new Map(Object.entries(texts).map(([filePath, text]) => [
    filePath,
    analyzeDocument(text, filePath, dsl),
  ]));
  const active = files.get(activeFile);
  const symbols = [...active.symbols, ...(activeFile === common ? [] : files.get(common).symbols)];
  return { symbols, common, dsl, files };
}

test('a local resolves through the locals it references, with the overlay winning', () => {
  const dsl = localsDsl();
  const texts = {
    [common]: [
      'locals:',
      '  prefix: mock',
      '  bucket: ${local.prefix}-${local.suffix}',
      '  suffix: common',
      '  alias: local.bucket',
      '  stamped: ${local.prefix}-${env}',
      '  token fn.ssm: /mock/token',
      '  tokened: ${local.token}',
      '',
    ].join('\n'),
    [overlay]: 'locals:\n  suffix: "one"\n',
  };
  const fromCommon = createLocalValues(stackOf(dsl, texts, common), common);
  assert.equal(fromCommon.valueOf('bucket').text, 'mock-common');
  assert.equal(fromCommon.valueOf('alias').text, 'mock-common');
  assert.deepEqual([fromCommon.valueOf('stamped').text, fromCommon.valueOf('stamped').known], ['mock-${env}', true]);
  assert.equal(fromCommon.valueOf('token').known, false);
  const tokened = fromCommon.valueOf('tokened');
  assert.deepEqual([tokened.text, tokened.known], ['${local.token}', false]);
  const fromOverlay = createLocalValues(stackOf(dsl, texts, overlay), overlay);
  assert.equal(fromOverlay.valueOf('alias').text, 'mock-one');
  assert.equal(fromOverlay.valueOf('missing'), null);
});

test('a local that reaches itself is a problem on its declaration and stays as written', () => {
  const dsl = localsDsl();
  const text = 'locals:\n  first: ${local.second}\n  second: local.first\n  fine: ok\nthing:\n  x: local.first\n';
  const stack = stackOf(dsl, { [common]: text }, common);
  const localValues = createLocalValues(stack, common);
  assert.equal(localValues.isCyclic('first'), true);
  assert.equal(localValues.isCyclic('fine'), false);
  assert.deepEqual([localValues.valueOf('first').text, localValues.valueOf('first').known], ['${local.second}', false]);
  const doc = stack.files.get(common);
  const messages = analysisProblems(doc, stack).map((problem) => problem.message);
  assert.deepEqual(messages, [
    'local first reaches itself through its references',
    'local second reaches itself through its references',
  ]);
  const hover = hoverAt(doc, { line: 5, character: 6 }, stack, null);
  assert.match(hover.contents.value, /\$\{local\.second\}/);
});

test('hover on a local shows its resolved value', () => {
  const dsl = localsDsl();
  const text = 'locals:\n  prefix: mock\n  bucket: ${local.prefix}-bucket\nthing:\n  x: local.bucket\n';
  const stack = stackOf(dsl, { [common]: text }, common);
  const hover = hoverAt(stack.files.get(common), { line: 4, character: 6 }, stack, null);
  assert.match(hover.contents.value, /```yaml-dsl/);
  assert.match(hover.contents.value.split('\n')[0], /mock\.yml:3/);
  assert.equal(hoverAt(stack.files.get(common), { line: 4, character: 6 }, { ...stack, files: null }, null)
    .contents.value, 'mock-bucket');
});

test('without a locals block there are no local values and no names known by them', () => {
  const withLocals = localsDsl();
  const withoutLocals = { ...withLocals, locals: null };
  const text = 'locals:\n  thing: mock-thing\nRESOURCE:\n  "name ${local.thing}": {}\n';
  const stack = stackOf(withLocals, { [common]: text }, common);
  const keyed = stack.symbols.find((symbol) => symbol.scopeName === 'RESOURCE');
  assert.equal(substitutedName(keyed, stack, common), 'mock-thing');
  assert.equal(substitutedName(keyed, { ...stack, dsl: withoutLocals }, common), null);
  assert.equal(createLocalValues({ ...stack, dsl: withoutLocals }, common).valueOf('thing'), null);
  assert.deepEqual(analysisProblems(stack.files.get(common), { ...stack, dsl: withoutLocals }), []);
});

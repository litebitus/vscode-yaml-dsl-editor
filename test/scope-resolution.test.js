const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../lib/config');
const { analyzeDocument, classifiedReferences, completionAt } = require('../lib/analyze');
const { isVisible } = require('../lib/scope-resolution');

const config = String.raw`
dsls:
  - id: tests
    includes: ["**/*.yml"]
    excludes: []
    schema: https://example.test/mock.json
    layers: none
    placeholders:
      pattern: '\$\{(?<body>[^}\n]*)\}'
    functions: none
    scopes:
      global: { visible_from: everywhere, names: [env] }
      setup: { visible_from: ["$.cases", "$.teardown"] }
      step: { visible_from: following }
    symbols:
      - at: "$.setup[*].*"
        skip: []
        exclude: []
        name: { from: meta_argument, argument: id }
        scope: setup
      - at: "$.setup[*].id"
        skip: []
        exclude: []
        name: { from: value }
        scope: setup
      - at: "$.cases[*].steps[*].*"
        skip: []
        exclude: []
        name: { from: meta_argument, argument: id }
        scope: step
    references:
      - pattern: '^setup\.(?<name>[a-z0-9_]+)'
        where: [placeholder, placeholder_in_string]
        trailing_text: any
        target: { scope: setup, name: name }
      - pattern: '^step\.(?<name>[a-z0-9_]+)'
        where: [placeholder, placeholder_in_string]
        trailing_text: any
        target: { scope: step, name: name }
      - pattern: '^(?<name>[a-z_]+)$'
        where: [placeholder, placeholder_in_string]
        trailing_text: none
        target: { scope: global, name: name }
`;

const text = [
  'setup:',
  '  - http(id=login):',
  '      url: ${env}',
  '  - id: seed',
  '    http: {}',
  'cases:',
  '  - steps:',
  '      - http(id=first): {}',
  '      - http:',
  '          body: ${step.first.token} ${step.later.x} ${setup.seed.id}',
  '      - http(id=later): {}',
  'teardown:',
  '  - http:',
  '      url: ${setup.login.token[0]}',
  'other:',
  '  - http:',
  '      url: ${setup.login.token}',
  '',
].join('\n');

const filePath = '/repo/mock.yml';

function stackFor() {
  const { dsls } = parseConfig(config);
  const doc = analyzeDocument(text, filePath, dsls[0]);
  const stack = {
    symbols: doc.symbols,
    common: filePath,
    files: new Map([[filePath, doc]]),
    root: '/repo',
    dsl: dsls[0],
  };
  return { doc, stack };
}

test('a scope is visible from the paths it names, or from later items of its own list', () => {
  const { doc, stack } = stackFor();
  assert.deepEqual(doc.symbols.map((symbol) => `${symbol.scope}.${symbol.name}`), [
    'setup.login',
    'setup.seed',
    'step.first',
    'step.later',
  ]);
  const kinds = classifiedReferences(doc, stack).map((reference) => reference.kind);
  assert.deepEqual(kinds, ['builtin', 'local', 'error', 'local', 'local', 'error']);
});

test('completion offers only the symbols visible where the cursor is', () => {
  const { doc, stack } = stackFor();
  const line = 9;
  const lineText = text.split('\n')[line];
  const position = { line, character: lineText.indexOf('${step.first') + 2 };
  const labels = completionAt(doc, lineText, position, stack).map((item) => item.label);
  assert.deepEqual(labels, ['${setup.login}', '${setup.seed}', '${step.first}', '${env}']);
});

test('a symbol with no visibility, or a site outside its file, sees nothing that is not stack-wide', () => {
  const dsl = { scopes: { step: { visibleFrom: { kind: 'following' } } } };
  const symbol = { scope: 'step', file: '/repo/a.yml', documentPath: ['steps', 0, 'http'] };
  const siteAt = (documentPath, file = '/repo/a.yml') => ({ file, documentPath });
  assert.equal(isVisible({ scope: 'nowhere' }, siteAt([]), dsl), false);
  assert.equal(isVisible(symbol, siteAt(['steps', 1], '/repo/b.yml'), dsl), false);
  assert.equal(isVisible(symbol, null, dsl), false);
  assert.equal(isVisible({ ...symbol, documentPath: ['steps'] }, siteAt(['steps', 1]), dsl), false);
  assert.equal(isVisible(symbol, siteAt(['steps']), dsl), false);
  assert.equal(isVisible(symbol, siteAt(['steps', 1, 'http']), dsl), true);
  assert.equal(isVisible({ ...symbol, visibility: { kind: 'everywhere' } }, null, null), true);
});

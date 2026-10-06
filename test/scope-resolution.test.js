const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../lib/config');
const {
  analyzeDocument,
  classifiedReferences,
  completionAt,
  definitionAt,
  hoverAt,
} = require('../lib/analyze');
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

const protocolConfig = String.raw`
dsls:
  - id: tests
    includes: ["**/*.yml"]
    excludes: []
    schema: []
    layers: none
    placeholders: none
    functions: none
    scopes:
      protocol: { visible_from: stack }
    symbols:
      - at: "$.protocols.*.messages"
        skip: []
        exclude: []
        name: { from: any }
        scope: protocol
    references:
      - pattern: '(?<![A-Za-z0-9_./])protocol\.(?<name>[a-z0-9_]+)'
        where: [within]
        trailing_text: any
        target: { scope: protocol, name: name }
`;

test('a scope declared by one key resolves every name in it to that key', () => {
  const { dsls, error } = parseConfig(protocolConfig);
  assert.equal(error, null);
  assert.deepEqual(dsls[0].symbols[0].name, { from: 'any', spelling: 'as_written' });
  const text = [
    'protocols:',
    '  websocket:',
    '    messages: ../protocols/mock/protocol.yml#mock',
    'cases:',
    '  - if: protocol.mock_exists && !protocol.mock_is_money',
    '    steps:',
    "      - websocket(id=spin, if='protocol.mock_is_money'):",
    '          exchange:',
    "            - patch(if='protocol.mock_patched'): {}",
    '',
  ].join('\n');
  const filePath = '/repo/mock.yml';
  const doc = analyzeDocument(text, filePath, dsls[0]);
  const stack = { symbols: doc.symbols, common: filePath, files: new Map([[filePath, doc]]), dsl: dsls[0] };
  const names = doc.references.map((reference) => reference.groups.name);
  assert.deepEqual(names, ['mock_exists', 'mock_is_money', 'mock_is_money', 'mock_patched']);
  assert.deepEqual(classifiedReferences(doc, stack).map((reference) => reference.kind), [
    'local',
    'local',
    'local',
    'local',
  ]);
  const position = { line: 4, character: text.split('\n')[4].indexOf('mock_exists') };
  assert.equal(definitionAt(doc, position, stack).range.start.line, 2);
  assert.match(hoverAt(doc, position, stack, null).contents.value, /protocol\.yml#mock/);
  const lineText = '  - if: protocol.';
  assert.deepEqual(completionAt(doc, lineText, { line: 4, character: lineText.length }, stack), []);
  const bare = analyzeDocument('cases:\n  - if: protocol.mock_exists\n', filePath, dsls[0]);
  const bareStack = { ...stack, symbols: bare.symbols, files: new Map([[filePath, bare]]) };
  assert.deepEqual(classifiedReferences(bare, bareStack).map((reference) => reference.kind), ['error']);
});

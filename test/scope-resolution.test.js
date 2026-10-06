const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeDocument,
  classifiedReferences,
  completionAt,
  definitionAt,
  hoverAt,
} = require('../lib/analyze');
const { isVisible } = require('../lib/scope-resolution');
const {
  scope,
  declaration,
  reference,
  placeholder,
  dslEntry,
  parsedDsl,
} = require('./config-builders');

const inPlaceholders = { positions: ['whole_placeholder', 'placeholder_in_text'] };
const metaArgumentId = { name_source: 'meta_argument', key_token: null, meta_argument_name: 'id' };

const testsDsl = parsedDsl(dslEntry('tests', {
  file_includes: ['**/*.yml'],
  placeholder: placeholder(),
  scopes: {
    GLOBAL: scope({ builtin_names: ['env'] }),
    CASE_VALUES: scope({ regions: ['$.cases'], builtin_names: ['game'] }),
    setup: scope({ regions: ['$.cases', '$.teardown'] }),
    step: scope({ regions: [], later_items_of_declaring_list: true }),
  },
  declarations: [
    declaration('$.setup[*].*', 'setup', metaArgumentId),
    declaration('$.setup[*].id', 'setup', { name_source: 'value', key_token: null }),
    declaration('$.cases[*].steps[*].*', 'step', metaArgumentId),
  ],
  references: [
    reference('^setup\\.(?<name>[a-z0-9_]+)', 'setup', { ...inPlaceholders, text_after_name_allowed: true }),
    reference('^step\\.(?<name>[a-z0-9_]+)', 'step', { ...inPlaceholders, text_after_name_allowed: true }),
    reference('^(?<name>[a-z_]+)$', 'GLOBAL', inPlaceholders),
    reference('^(?<name>[a-z_]+)$', 'CASE_VALUES', inPlaceholders),
  ],
}));

const text = [
  'setup:',
  '  - http(id=login):',
  '      url: ${env} ${game}',
  '  - id: seed',
  '    http: {}',
  'cases:',
  '  - steps:',
  '      - http(id=first): {}',
  '      - http:',
  '          body: ${step.first.token} ${step.later.x} ${setup.seed.id} ${game}',
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

function stackFor(dsl = testsDsl, documentText = text) {
  const doc = analyzeDocument(documentText, filePath, dsl);
  const stack = { symbols: doc.symbols, common: filePath, files: new Map([[filePath, doc]]), root: '/repo', dsl };
  return { doc, stack };
}

test('a scope is visible in the regions it names, or from later items of its own list', () => {
  const { doc, stack } = stackFor();
  assert.deepEqual(doc.symbols.map((symbol) => `${symbol.scope}.${symbol.name}`), [
    'setup.login',
    'setup.seed',
    'step.first',
    'step.later',
  ]);
  const kinds = classifiedReferences(doc, stack).map((classified) => classified.kind);
  assert.deepEqual(kinds, ['builtin', 'error', 'local', 'error', 'local', 'builtin', 'local', 'error']);
});

test('completion offers only the symbols visible where the cursor is', () => {
  const { doc, stack } = stackFor();
  const line = 9;
  const lineText = text.split('\n')[line];
  const position = { line, character: lineText.indexOf('${step.first') + 2 };
  const labels = completionAt(doc, lineText, position, stack).map((item) => item.label);
  assert.deepEqual(labels, ['${setup.login}', '${setup.seed}', '${step.first}', '${env}', '${game}']);
  const setupLine = 2;
  const setupText = text.split('\n')[setupLine];
  const inSetup = { line: setupLine, character: setupText.indexOf('${env') + 2 };
  const setupLabels = completionAt(doc, setupText, inSetup, stack).map((item) => item.label);
  assert.deepEqual(setupLabels, ['${env}']);
});

test('a symbol with no declared scope, or a site outside its list, sees nothing later items do not reach', () => {
  const followingScope = { regions: [], laterItemsOfDeclaringList: true, namedByParentKey: false, builtinNames: [] };
  const dsl = { scopes: { step: followingScope } };
  const symbol = { scope: 'step', scopeName: 'step', file: '/repo/a.yml', documentPath: ['steps', 0, 'http'] };
  const siteAt = (documentPath, file = '/repo/a.yml') => ({ file, documentPath });
  assert.equal(isVisible({ scope: 'nowhere', scopeName: 'nowhere' }, siteAt([]), dsl), false);
  assert.equal(isVisible(symbol, siteAt(['steps', 1], '/repo/b.yml'), dsl), false);
  assert.equal(isVisible(symbol, null, dsl), false);
  assert.equal(isVisible({ ...symbol, documentPath: ['steps'] }, siteAt(['steps', 1]), dsl), false);
  assert.equal(isVisible(symbol, siteAt(['steps']), dsl), false);
  assert.equal(isVisible(symbol, siteAt(['steps', 1, 'http']), dsl), true);
  const everywhere = { scopes: { step: { ...followingScope, regions: [[]] } } };
  assert.equal(isVisible(symbol, null, everywhere), true);
});

test('a declaration of every name resolves each name in its scope to that key', () => {
  const protocolDsl = parsedDsl(dslEntry('tests', {
    file_includes: ['**/*.yml'],
    scopes: { protocol: scope() },
    declarations: [declaration('$.protocols.*.messages', 'protocol', { declares_every_name: true })],
    references: [
      reference('(?<![A-Za-z0-9_./])protocol\\.(?<name>[a-z0-9_]+)', 'protocol', {
        positions: ['anywhere_in_scalar'],
        text_after_name_allowed: true,
      }),
    ],
  }));
  assert.equal(protocolDsl.declarations[0].declaresEveryName, true);
  const protocolText = [
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
  const { doc, stack } = stackFor(protocolDsl, protocolText);
  const names = doc.references.map((found) => found.groups.name);
  assert.deepEqual(names, ['mock_exists', 'mock_is_money', 'mock_is_money', 'mock_patched']);
  assert.deepEqual(classifiedReferences(doc, stack).map((classified) => classified.kind), [
    'local',
    'local',
    'local',
    'local',
  ]);
  const position = { line: 4, character: protocolText.split('\n')[4].indexOf('mock_exists') };
  assert.equal(definitionAt(doc, position, stack).range.start.line, 2);
  assert.match(hoverAt(doc, position, stack, null).contents.value, /protocol\.yml#mock/);
  const lineText = '  - if: protocol.';
  assert.deepEqual(completionAt(doc, lineText, { line: 4, character: lineText.length }, stack), []);
  const bare = stackFor(protocolDsl, 'cases:\n  - if: protocol.mock_exists\n');
  assert.deepEqual(classifiedReferences(bare.doc, bare.stack).map((classified) => classified.kind), ['error']);
});

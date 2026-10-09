const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, hoverAt, definitionAt, linksFor, pathToUri, uriToPath } = require('../lib/analyze');

function rangeOf(text, needle) {
  const index = text.indexOf(needle);
  const at = (offset) => ({
    line: text.slice(0, offset).split('\n').length - 1,
    character: offset - text.lastIndexOf('\n', offset - 1) - 1,
  });
  return { start: at(index), end: at(index + needle.length) };
}

test('paths convert to file uris and back', () => {
  assert.equal(pathToUri('/repo/a.yml'), 'file:///repo/a.yml');
  assert.equal(pathToUri('repo/a.yml'), 'file:///repo/a.yml');
  assert.equal(uriToPath('file:///repo/a%20b.yml'), '/repo/a b.yml');
  assert.equal(uriToPath('untitled:1'), 'untitled:1');
});

test('hover and definition outside a reference or a field are empty', () => {
  const doc = analyzeDocument('name: plain\n', '/repo/a.yml', { symbols: [], references: [] });
  const stack = { symbols: [], common: '/repo/a.yml' };
  assert.equal(hoverAt(null, { line: 0, character: 0 }, stack, {}), null);
  assert.equal(definitionAt(null, { line: 0, character: 0 }, stack), null);
  assert.equal(hoverAt(doc, { line: 4, character: 0 }, stack, { description: 'root' }), null);
  assert.equal(hoverAt(doc, { line: 0, character: 0 }, stack, null), null);
  assert.equal(definitionAt(doc, { line: 0, character: 0 }, stack), null);
  const described = hoverAt(doc, { line: 0, character: 0 }, stack, {
    properties: { name: { description: 'the name' } },
  });
  assert.equal(described.contents.value, 'the name');
});

const refRule = {
  pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
  positions: ['whole_scalar'],
  textAfterNameAllowed: true,
  scopeName: 'RESOURCE',
  scopeGroup: 'type',
  nameGroup: 'name',
};
const localRule = {
  pattern: '^local\\.(?<name>[a-z0-9_]+)$',
  positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
  textAfterNameAllowed: false,
  scopeName: 'local',
  scopeGroup: null,
  nameGroup: 'name',
};
const declaredScope = (fields = {}) => ({
  regions: [[]],
  laterItemsOfDeclaringList: false,
  namedByParentKey: false,
  builtinNames: [],
  ...fields,
});
const stackScopes = { local: declaredScope(), RESOURCE: declaredScope({ namedByParentKey: true }) };
const zero = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function typed(name, file, extra = {}) {
  return {
    scope: 'mocktype',
    scopeName: 'RESOURCE',
    name,
    file,
    keyRange: zero,
    valueText: '',
    valueIsScalar: false,
    ...extra,
  };
}

function localSymbol(name, file, valueText, extra = {}) {
  return { scope: 'local', scopeName: 'local', name, file, keyRange: zero, valueText, valueIsScalar: true, ...extra };
}

function stackOf(symbols, extra = {}) {
  return {
    symbols,
    common: '/repo/mock.yml',
    dsl: { scopes: stackScopes, references: [refRule, localRule] },
    ...extra,
  };
}

test('the active file wins, then the common layer, then the first other declaration in the fold', () => {
  const doc = analyzeDocument('source: ref mocktype.primary\n', '/repo/two/mock.yml', { references: [refRule] });
  const symbols = [
    typed('primary', '/repo/three/mock.yml'),
    typed('primary', '/repo/four/mock.yml'),
    typed('other', '/repo/mock.yml'),
    localSymbol('primary', '/repo/mock.yml', 'no'),
  ];
  assert.equal(definitionAt(doc, { line: 0, character: 8 }, stackOf(symbols)).path, '/repo/three/mock.yml');
  symbols.unshift(typed('primary', '/repo/mock.yml'));
  assert.equal(definitionAt(doc, { line: 0, character: 8 }, stackOf(symbols)).path, '/repo/mock.yml');
  const withActive = [...symbols, typed('primary', '/repo/two/mock.yml')];
  assert.equal(definitionAt(doc, { line: 0, character: 8 }, stackOf(withActive)).path, '/repo/two/mock.yml');
  assert.deepEqual(linksFor(doc, stackOf(symbols)), []);
  const hover = hoverAt(doc, { line: 0, character: 8 }, stackOf(symbols), null);
  assert.match(hover.contents.value, /mocktype\.primary — \/repo\/mock\.yml/);
  const files = (text) => new Map([['/repo/mock.yml', { text }]]);
  const sectionFiles = files('  primary:\n\n    label: 1\nnext:\n');
  const shown = hoverAt(doc, { line: 0, character: 8 }, stackOf(symbols, { files: sectionFiles }), null);
  assert.match(shown.contents.value, /primary:/);
  assert.match(shown.contents.value, /label: 1/);
  assert.doesNotMatch(shown.contents.value, /next:/);
  const longBody = ['primary:', ...Array.from({ length: 30 }, (_, i) => `  line${i}`), 'sibling:'].join('\n');
  const full = hoverAt(doc, { line: 0, character: 8 }, stackOf(symbols, { files: files(longBody) }), null);
  assert.match(full.contents.value, /line29/);
  assert.doesNotMatch(full.contents.value, /sibling:/);
  const missing = analyzeDocument('source: ref mocktype.missing\n', '/repo/two/mock.yml', { references: [refRule] });
  const missingHover = hoverAt(missing, { line: 0, character: 8 }, stackOf([]), null);
  assert.equal(missingHover.contents.value, 'Invalid reference: mocktype.missing');
  assert.equal(definitionAt(missing, { line: 0, character: 8 }, stackOf([])), null);
  assert.deepEqual(linksFor(missing, stackOf([])), []);
  const fieldPath = 'item: ref mocktype.primary.tail\n';
  const fieldDoc = analyzeDocument(fieldPath, '/repo/two/mock.yml', { references: [refRule] });
  assert.deepEqual(definitionAt(fieldDoc, { line: 0, character: 8 }, stackOf(symbols)).origin, rangeOf(fieldPath, 'ref mocktype.primary.tail'));
  const localTyped = analyzeDocument('item: ref local.primary\n', '/repo/two/mock.yml', { references: [refRule] });
  assert.equal(definitionAt(localTyped, { line: 0, character: 8 }, stackOf(symbols)), null);
});

test('a ref named by a local value opens the declaration in the active file first', () => {
  const doc = analyzeDocument('item: ref mocktype.kds_bullet\n', '/repo/one/mock.yml', { references: [refRule] });
  const range = { start: { line: 2, character: 2 }, end: { line: 2, character: 8 } };
  const keyed = { nameSpelling: 'dashes_as_underscores', keyRange: range };
  const symbols = [
    localSymbol('bullet', '/repo/one/mock.yml', '"kds-bullet"'),
    localSymbol('bullet', '/repo/mock.yml', 'other-bullet'),
    typed('${local.bullet}', '/repo/one/mock.yml', keyed),
    typed('${local.bullet}', '/repo/mock.yml', keyed),
  ];
  const placeholder = { pattern: '\\$\\{(?<body>[^}]*)\\}', unscannedPaths: [] };
  const withPlaceholders = (list) => stackOf(list, {
    dsl: { scopes: stackScopes, references: [refRule, localRule], placeholder, locals: { scopeName: 'local' } },
  });
  const hit = definitionAt(doc, { line: 0, character: 12 }, withPlaceholders(symbols));
  assert.equal(hit.path, '/repo/one/mock.yml');
  assert.equal(hit.range.start.line, 2);
  assert.equal(definitionAt(doc, { line: 0, character: 12 }, stackOf(symbols)), null);
  const unvalued = symbols.map((symbol) => (symbol.scope === 'local' ? { ...symbol, valueText: '' } : symbol));
  assert.equal(definitionAt(doc, { line: 0, character: 12 }, withPlaceholders(unvalued)), null);
  const unmatched = [typed('${nope}', '/repo/mock.yml', keyed)];
  assert.equal(definitionAt(doc, { line: 0, character: 12 }, withPlaceholders(unmatched)), null);
});

test('a hover on a valued target shows its value, and a builtin names its scope', () => {
  const globalRule = {
    pattern: '^(?<name>[a-z]+)$',
    positions: ['whole_placeholder'],
    textAfterNameAllowed: false,
    scopeName: 'GLOBAL',
    scopeGroup: null,
    nameGroup: 'name',
  };
  const dsl = {
    references: [localRule, globalRule],
    placeholder: { pattern: '\\$\\{(?<body>[^}]*)\\}', unscannedPaths: [] },
  };
  const doc = analyzeDocument('name: local.db\nwhere: ${env}\n', '/repo/a.yml', dsl);
  const scopes = { ...stackScopes, GLOBAL: declaredScope({ builtinNames: ['env'] }) };
  const stack = (symbols) => ({ symbols, common: '/repo/mock.yml', dsl: { ...dsl, scopes } });
  const symbol = localSymbol('db', '/repo/mock.yml', 'mock-value', { keyRange: doc.tree.range });
  assert.equal(hoverAt(doc, { line: 0, character: 8 }, stack([symbol]), null).contents.value, 'mock-value');
  assert.equal(hoverAt(doc, { line: 0, character: 8 }, stack([]), null).contents.value, 'Invalid reference: local.db');
  assert.equal(hoverAt(doc, { line: 1, character: 9 }, stack([]), null).contents.value, 'GLOBAL env');
  assert.equal(definitionAt(doc, { line: 1, character: 9 }, stack([])), null);
  assert.deepEqual(linksFor(doc, stack([])), []);
});

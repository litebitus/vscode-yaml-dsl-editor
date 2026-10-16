const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeDocument,
  hoverAt,
  deprecatedFields,
  definitionAt,
  linksFor,
  pathToUri,
  uriToPath,
} = require('../lib/analyze');

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
  assert.equal(described.contents.value, '```\nname    [optional]\n```\n\nthe name');
});

test('a deprecated field hovers its description, and its keys are listed with a warning message naming them', () => {
  const text = 'mocktype:\n  old: 1\n  plain: 2\n  bare: 3\n';
  const doc = analyzeDocument(text, '/repo/a.yml', { symbols: [], references: [] });
  const stack = { symbols: [], common: '/repo/a.yml' };
  const fields = {
    old: { description: 'use plain', deprecated: true },
    plain: { description: 'the plain field' },
    bare: { deprecated: true },
  };
  const schemaOf = (draftUri) => ({ $schema: draftUri, properties: { mocktype: { properties: fields } } });
  const draft2020 = schemaOf('https://json-schema.org/draft/2020-12/schema');
  const hoverValue = (line, schema) => hoverAt(doc, { line, character: 2 }, stack, schema).contents.value;
  assert.equal(hoverValue(1, draft2020), '```\nold    [optional]\n```\n\nuse plain\n\n*Deprecated*');
  assert.equal(hoverValue(2, draft2020), '```\nplain    [optional]\n```\n\nthe plain field');
  assert.equal(hoverValue(3, draft2020), '```\nbare    [optional]\n```\n\n*Deprecated*');
  assert.deepEqual(deprecatedFields(doc, draft2020), [
    { range: rangeOf(text, 'old'), fieldRange: rangeOf(text, 'old: 1'), message: '`old` is deprecated: use plain' },
    { range: rangeOf(text, 'bare'), fieldRange: rangeOf(text, 'bare: 3'), message: '`bare` is deprecated' },
  ]);
  const draft07 = schemaOf('http://json-schema.org/draft-07/schema#');
  assert.equal(hoverValue(1, draft07), '```\nold    [optional]\n```\n\nuse plain');
  assert.deepEqual(deprecatedFields(doc, draft07), []);
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
  assert.equal(hover.contents.value, 'mocktype\\.primary — /repo/mock\\.yml');
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
  assert.equal(missingHover.contents.value, 'Invalid reference: mocktype\\.missing');
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

test('a field hover documents it: a signature with its shape and requirement, its description as markdown, its constraints', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      number_or_ref: { oneOf: [{ type: 'number' }, { $ref: '#/$defs/ref' }, { $ref: '#/$defs/local' }] },
      ref: { type: 'string', pattern: '^ref ' },
      local: { type: 'string', pattern: '^local\\.' },
    },
    properties: {
      mock: {
        type: 'object',
        required: ['threshold'],
        allOf: [{ if: { properties: { mode: { const: 'slow' } } }, then: { not: { required: ['tags'] } } }],
        properties: {
          mode: {
            type: 'string',
            enum: ['fast', 'slow'],
            default: 'fast',
            description: '[optional] The `mode`, *one* per line.\nSecond line.',
          },
          threshold: { $ref: '#/$defs/number_or_ref', minimum: 1 },
          tags: { type: 'array', items: { type: 'string', pattern: '^mock-' } },
        },
      },
    },
  };
  const text = 'mock:\n  mode: fast\n  threshold: 2\n  tags:\n    - mock-a\n';
  const doc = analyzeDocument(text, '/repo/a.yml', { symbols: [], references: [] });
  const documentationAt = (needle) => hoverAt(doc, rangeOf(text, needle).start, { symbols: [] }, schema).contents;
  assert.deepEqual(documentationAt('mode'), {
    kind: 'markdown',
    value: [
      '```\nmode: string    [optional]\n```',
      'The `mode`, *one* per line.\nSecond line.',
      '*One of:* `"fast"`, `"slow"`  \n*Default:* `"fast"`',
    ].join('\n\n'),
  });
  assert.equal(documentationAt('threshold').value, [
    '```\nthreshold: number | ref | local    [required]\n```',
    [
      '*Accepts:*',
      '- `number`: *Minimum:* `1`',
      '- `ref`: string, *Pattern:* `^ref `, *Minimum:* `1`',
      '- `local`: string, *Pattern:* `^local\\.`, *Minimum:* `1`',
    ].join('\n'),
  ].join('\n\n'));
  assert.equal(
    documentationAt('mock:').value,
    '```\nmock: object    [optional]\n```\n\n*When* `mode` is `"slow"`: `tags` must not be set.',
  );
  assert.equal(
    documentationAt('tags').value,
    '```\ntags: array    [optional]\n```\n\n*Items:* `string`  \n*When* `mode` is `"slow"`: must not be set.',
  );
  assert.equal(documentationAt('mock-a').value, '```\ntags[0]: string\n```\n\n*Pattern:* `^mock-`');
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
  assert.equal(hoverAt(doc, { line: 0, character: 8 }, stack([symbol]), null).contents.value, 'mock\\-value');
  assert.equal(hoverAt(doc, { line: 0, character: 8 }, stack([]), null).contents.value, 'Invalid reference: local\\.db');
  assert.equal(hoverAt(doc, { line: 1, character: 9 }, stack([]), null).contents.value, 'GLOBAL env');
  assert.equal(definitionAt(doc, { line: 1, character: 9 }, stack([])), null);
  assert.deepEqual(linksFor(doc, stack([])), []);
});

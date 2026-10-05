const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, hoverAt, definitionAt, pathToUri, uriToPath } = require('../lib/analyze');

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

test('an active file wins, then the common layer, then the earliest other file', () => {
  const doc = analyzeDocument('source: ref redshift.primary\n', '/repo/staging/resources.yml', {
    symbols: [],
    references: [{
      pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
      where: 'whole',
      target: { kind: 'resource', type: 'type', name: 'name' },
    }],
  });
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const symbols = [
    { kind: 'resource', name: 'primary', qualifiers: { type: 'redshift' }, file: '/repo/uat/resources.yml', keyRange: range, valueText: '' },
    { kind: 'resource', name: 'primary', qualifiers: { type: 'redshift' }, file: '/repo/production/resources.yml', keyRange: range, valueText: '' },
    { kind: 'resource', name: 'other', qualifiers: { type: 'redshift' }, file: '/repo/resources.yml', keyRange: range, valueText: '' },
    { kind: 'local', name: 'primary', qualifiers: {}, file: '/repo/resources.yml', keyRange: range, valueText: 'no' },
  ];
  const hit = definitionAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/resources.yml' });
  assert.equal(hit.path, '/repo/production/resources.yml');
  symbols.unshift({ kind: 'resource', name: 'primary', qualifiers: { type: 'redshift' }, file: '/repo/resources.yml', keyRange: range, valueText: '' });
  assert.equal(definitionAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/resources.yml' }).path, '/repo/resources.yml');
  symbols.unshift({ kind: 'resource', name: 'primary', qualifiers: { type: 'redshift' }, file: '/repo/staging/resources.yml', keyRange: range, valueText: 'here' });
  const active = definitionAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/resources.yml' });
  assert.equal(active.path, '/repo/staging/resources.yml');
  const hover = hoverAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/resources.yml' }, null);
  assert.match(hover.contents.value, /redshift\.primary — \/repo\/staging\/resources\.yml/);
  const missing = analyzeDocument('source: ref redshift.missing\n', '/repo/staging/resources.yml', {
    symbols: [],
    references: doc.references.length ? [{
      pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
      where: 'whole',
      target: { kind: 'resource', type: 'type', name: 'name' },
    }] : [],
  });
  const unresolved = hoverAt(missing, { line: 0, character: 8 }, { symbols: [], common: '/repo/resources.yml' }, null);
  assert.equal(unresolved.contents.value, 'redshift.missing');
  assert.equal(definitionAt(missing, { line: 0, character: 8 }, { symbols: [], common: '/repo/resources.yml' }), null);
});

test('a local hover shows the authored value', () => {
  const doc = analyzeDocument('name: local.db\n', '/repo/a.yml', {
    symbols: [],
    references: [{ pattern: '^local\\.(?<name>[a-z0-9_]+)$', where: 'whole', target: { kind: 'local', name: 'name' } }],
  });
  const symbol = { kind: 'local', name: 'db', qualifiers: {}, file: '/repo/resources.yml', keyRange: doc.tree.range, valueText: 'warehouse' };
  const hover = hoverAt(doc, { line: 0, character: 8 }, { symbols: [symbol], common: '/repo/resources.yml' }, null);
  assert.equal(hover.contents.value, 'warehouse');
  const bare = hoverAt(doc, { line: 0, character: 8 }, { symbols: [], common: '/repo/resources.yml' }, null);
  assert.equal(bare.contents.value, 'db');
  const nameless = analyzeDocument('name: marker\n', '/repo/a.yml', {
    symbols: [],
    references: [{ pattern: 'marker', where: 'whole', target: { kind: 'resource' } }],
  });
  const marked = hoverAt(nameless, { line: 0, character: 6 }, { symbols: [], common: '/repo/a.yml' }, null);
  assert.equal(marked.contents.value, '');
});

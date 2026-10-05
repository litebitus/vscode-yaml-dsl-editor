const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument, hoverAt, definitionAt, linksFor, linkTarget, pathToUri, uriToPath } = require('../lib/analyze');

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

test('an active file wins, then the common layer, then the earliest other file', () => {
  const doc = analyzeDocument('source: ref mocktype.primary\n', '/repo/two/mock.yml', {
    symbols: [],
    references: [{
      pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
      where: 'whole',
      target: { kind: 'resource', type: 'type', name: 'name' },
    }],
  });
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const symbols = [
    { kind: 'resource', name: 'primary', qualifiers: { type: 'mocktype' }, file: '/repo/three/mock.yml', keyRange: range, valueText: '' },
    { kind: 'resource', name: 'primary', qualifiers: { type: 'mocktype' }, file: '/repo/four/mock.yml', keyRange: range, valueText: '' },
    { kind: 'resource', name: 'other', qualifiers: { type: 'mocktype' }, file: '/repo/mock.yml', keyRange: range, valueText: '' },
    { kind: 'local', name: 'primary', qualifiers: {}, file: '/repo/mock.yml', keyRange: range, valueText: 'no' },
  ];
  const hit = definitionAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/mock.yml' });
  assert.equal(hit.path, '/repo/four/mock.yml');
  symbols.unshift({ kind: 'resource', name: 'primary', qualifiers: { type: 'mocktype' }, file: '/repo/mock.yml', keyRange: range, valueText: '' });
  assert.equal(definitionAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/mock.yml' }).path, '/repo/mock.yml');
  symbols.unshift({ kind: 'resource', name: 'primary', qualifiers: { type: 'mocktype' }, file: '/repo/two/mock.yml', keyRange: range, valueText: 'here' });
  const active = definitionAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/mock.yml' });
  assert.equal(active.path, '/repo/two/mock.yml');
  const links = linksFor(doc, { symbols, common: '/repo/mock.yml' });
  assert.equal(links.length, 1);
  assert.equal(links[0].path, '/repo/two/mock.yml');
  assert.match(linkTarget(links[0].path, links[0].targetRange), /^file:\/\/\/repo\/two\/mock\.yml#1,/);
  const hover = hoverAt(doc, { line: 0, character: 8 }, { symbols, common: '/repo/mock.yml' }, null);
  assert.match(hover.contents.value, /mocktype\.primary — \/repo\/two\/mock\.yml/);
  const missing = analyzeDocument('source: ref mocktype.missing\n', '/repo/two/mock.yml', {
    symbols: [],
    references: doc.references.length ? [{
      pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
      where: 'whole',
      target: { kind: 'resource', type: 'type', name: 'name' },
    }] : [],
  });
  const unresolved = hoverAt(missing, { line: 0, character: 8 }, { symbols: [], common: '/repo/mock.yml' }, null);
  assert.equal(unresolved.contents.value, 'mocktype.missing');
  assert.equal(definitionAt(missing, { line: 0, character: 8 }, { symbols: [], common: '/repo/mock.yml' }), null);
  assert.deepEqual(linksFor(missing, { symbols: [], common: '/repo/mock.yml' }), []);
  const fieldPath = 'item: ref mocktype.primary.tail\n';
  const fieldDoc = analyzeDocument(fieldPath, '/repo/two/mock.yml', {
    symbols: [],
    references: [{
      pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)',
      where: 'whole',
      target: { kind: 'resource', type: 'type', name: 'name' },
    }],
  });
  const fieldLink = linksFor(fieldDoc, {
    symbols,
    common: '/repo/mock.yml',
  })[0];
  assert.equal(fieldPath.slice(
    fieldPath.indexOf('ref mocktype.primary.tail'),
    fieldPath.indexOf('ref mocktype.primary.tail') + 'ref mocktype.primary.tail'.length,
  ), 'ref mocktype.primary.tail');
  assert.deepEqual(fieldLink.range, rangeOf(fieldPath, 'ref mocktype.primary.tail'));
  const inside = 'item: "pre ${local.db} tail"\n';
  const insideDoc = analyzeDocument(inside, '/repo/a.yml', {
    symbols: [],
    references: [{
      pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}',
      where: 'within',
      target: { kind: 'local', name: 'name' },
    }],
  });
  const insideLink = linksFor(insideDoc, {
    symbols: [{ kind: 'local', name: 'db', qualifiers: {}, file: '/repo/a.yml', keyRange: range, valueText: 'x' }],
    common: '/repo/a.yml',
  })[0];
  assert.deepEqual(insideLink.range, rangeOf(inside, 'local.db'));
});

test('a local hover shows the authored value', () => {
  const doc = analyzeDocument('name: local.db\n', '/repo/a.yml', {
    symbols: [],
    references: [{ pattern: '^local\\.(?<name>[a-z0-9_]+)$', where: 'whole', target: { kind: 'local', name: 'name' } }],
  });
  const symbol = { kind: 'local', name: 'db', qualifiers: {}, file: '/repo/mock.yml', keyRange: doc.tree.range, valueText: 'mock-value' };
  const hover = hoverAt(doc, { line: 0, character: 8 }, { symbols: [symbol], common: '/repo/mock.yml' }, null);
  assert.equal(hover.contents.value, 'mock-value');
  const bare = hoverAt(doc, { line: 0, character: 8 }, { symbols: [], common: '/repo/mock.yml' }, null);
  assert.equal(bare.contents.value, 'db');
  const nameless = analyzeDocument('name: marker\n', '/repo/a.yml', {
    symbols: [],
    references: [{ pattern: 'marker', where: 'whole', target: { kind: 'resource' } }],
  });
  const marked = hoverAt(nameless, { line: 0, character: 6 }, { symbols: [], common: '/repo/a.yml' }, null);
  assert.equal(marked.contents.value, '');
});

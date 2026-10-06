const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');

function rule(extra) {
  return {
    kind: 'resource',
    at: '$.*.*',
    skip: [],
    exclude: [],
    name: { token: null, spelling: null },
    qualify: {},
    ...extra,
  };
}

function doc(text, symbols, references = []) {
  return analyzeDocument(text, '/repo/mock.yml', { symbols, references });
}

test('resource identity is the last token with dashes written as underscores', () => {
  const text = 'mocktype:\n  primary: {}\n  defaults: {}\n  "name mock-thing-v2": {}\nlocals:\n  db: mock-value\nschema_version: 3\n';
  const analyzed = doc(text, [
    rule({
      at: '$.*.*',
      skip: ['schema_version', 'locals'],
      exclude: ['defaults'],
      name: { token: 'last', spelling: 'snake' },
      qualify: { type: 'parent' },
    }),
    rule({ kind: 'local', at: '$.locals.*', name: { token: null, spelling: null }, qualify: {} }),
  ]);
  const names = analyzed.symbols.map((symbol) => `${symbol.kind}:${symbol.qualifiers.type || ''}:${symbol.name}`);
  assert.ok(names.includes('resource:mocktype:primary'));
  assert.ok(names.includes('resource:mocktype:mock_thing_v2'));
  assert.ok(names.includes('local::db'));
  assert.equal(names.some((name) => name.includes('defaults')), false);
  assert.equal(names.some((name) => name.includes('schema_version')), false);
  assert.equal(analyzed.symbols.find((symbol) => symbol.name === 'db').valueText, 'mock-value');
});

test('path steps that do not match a node produce no symbol', () => {
  const analyzed = doc('a: 1\nitems:\n  - primary: 1\n    other: 2\n', [
    rule({ at: 'nope' }),
    rule({ at: '$' }),
    rule({ at: '$.' }),
    rule({ at: '$[0]' }),
    rule({ at: '$.missing' }),
    rule({ at: '$.a.b' }),
    rule({ at: '$.*' }),
    rule({ at: '$.a.*' }),
    rule({ at: '$.items[*]' }),
    rule({ at: '$.items[*].*' }),
    rule({ at: '$.a[*].*' }),
    rule({ kind: 'meta', at: '$.items', name: { token: null, spelling: null }, qualify: { type: 'parent' } }),
  ]);
  const starred = analyzed.symbols.filter((symbol) => symbol.kind === 'resource').map((symbol) => symbol.name);
  assert.ok(starred.includes('primary'));
  assert.ok(starred.includes('other'));
  assert.ok(starred.includes('a'));
  const meta = analyzed.symbols.find((symbol) => symbol.kind === 'meta');
  assert.equal(meta.qualifiers.type, null);
});

test('whole scalars and matches inside a scalar are references', () => {
  const text = 'source: ref mocktype.primary.label\nnote: "use ${local.db} now"\nplain: local.db\nnum: 1\nlater: xname\nescaped: "a\\n"\n';
  const analyzed = doc(text, [], [
    { pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', where: 'whole', target: { kind: 'resource', type: 'type', name: 'name' } },
    { pattern: '^local\\.(?<name>[a-z0-9_]+)$', where: 'whole', target: { kind: 'local', name: 'name' } },
    { pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}', where: 'within', target: { kind: 'local', name: 'name' } },
    { pattern: 'name', where: 'whole', target: { kind: 'resource', name: 'name' } },
    { pattern: 'xna', where: 'within', target: { kind: 'local', name: 'missing' } },
  ]);
  assert.equal(analyzed.references.length >= 3, true);
  const ref = analyzed.references.find((item) => item.groups.type === 'mocktype');
  assert.equal(ref.groups.name, 'primary');
  assert.equal(ref.range.start.line, 0);
  const within = analyzed.references.find((item) => item.groups.name === 'db' && item.range.start.line === 1);
  assert.ok(within);
  const keyed = doc('${local.db}: 1\n', [], [
    { pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}', where: 'within', target: { kind: 'local', name: 'name' } },
  ]);
  const keyRef = keyed.references.find((item) => item.groups.name === 'db');
  assert.equal(keyRef.range.start.character, 0);
  assert.equal(keyRef.range.end.character, 11);
  assert.ok(analyzed.references.some((item) => item.groups.name === 'missing' || item.target.name === 'missing'));
});

test('a first-token name reads a function-bound key by its leading word', () => {
  const text = 'locals:\n  operator_key fn.ssm: /mock/key\n  plain: mock-value\n';
  const analyzed = doc(text, [rule({ kind: 'local', at: '$.locals.*', name: { token: 'first', spelling: null } })]);
  assert.deepEqual(analyzed.symbols.map((symbol) => symbol.name), ['operator_key', 'plain']);
});

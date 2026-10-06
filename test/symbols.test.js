const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');
const { parseAt } = require('../lib/document-path');

function rule(at, extra = {}) {
  return {
    at,
    tokens: parseAt(at),
    skip: [],
    exclude: [],
    name: { from: 'key', token: 'whole', spelling: 'as_written' },
    scope: { literal: 'thing' },
    ...extra,
  };
}

function reference(pattern, where, extra = {}) {
  return {
    pattern,
    where,
    trailingText: 'none',
    target: { scope: { literal: 'thing' }, name: 'name' },
    ...extra,
  };
}

const functions = {
  marker: 'fn.',
  splat: '*',
  vocabulary: [],
  unnamedCalls: 'sole_key',
  callResultsWhere: ['whole'],
  refusedAt: [],
};

function doc(text, dsl) {
  const empty = { symbols: [], references: [], placeholders: null, functions: null };
  return analyzeDocument(text, '/repo/mock.yml', { ...empty, ...dsl });
}

test('a key names a symbol by a token, spelled as the rule says, in a literal or enclosing scope', () => {
  const text = [
    'mocktype:',
    '  primary: {}',
    '  defaults: {}',
    '  "name mock-thing-v2": {}',
    'locals:',
    '  db: mock-value',
    '  operator_key fn.ssm: /mock/key',
    'schema_version: 3',
    '',
  ].join('\n');
  const analyzed = doc(text, {
    functions,
    symbols: [
      rule('$.*.*', {
        skip: ['schema_version', 'locals'],
        exclude: ['defaults'],
        name: { from: 'key', token: 'last', spelling: 'snake' },
        scope: { fromParent: true, visibleFrom: { kind: 'stack' } },
      }),
      rule('$.locals.*', {
        name: { from: 'key', token: 'first', spelling: 'as_written' },
        scope: { literal: 'local' },
      }),
    ],
  });
  const names = analyzed.symbols.map((symbol) => `${symbol.scope}:${symbol.name}`);
  assert.deepEqual(names, ['mocktype:primary', 'mocktype:mock_thing_v2', 'local:db', 'local:operator_key']);
  const local = analyzed.symbols.find((symbol) => symbol.name === 'db');
  assert.deepEqual([local.valueText, local.valueIsScalar, local.call], ['mock-value', true, false]);
  assert.equal(analyzed.symbols.find((symbol) => symbol.name === 'operator_key').call, true);
  assert.deepEqual(analyzed.symbols[0].documentPath, ['mocktype', 'primary']);
  assert.deepEqual(analyzed.symbols[0].visibility, { kind: 'stack' });
});

test('a name can come from a value or from a meta argument, one symbol per listed id', () => {
  const text = [
    'setup:',
    '  - lua: |',
    '      return 1',
    '    id: after',
    '  - http(id=config, retry=5/200ms/10s):',
    '      url: x',
    '  - game_session(id=[alice, bob], kind=slot):',
    '      game: MOCK',
    "  - websocket(id='quoted, id', if='a > 1'):",
    '      event: x',
    '  - lua(): x',
    '  - plain: x',
    '  - id: 1',
    '',
  ].join('\n');
  const analyzed = doc(text, {
    symbols: [
      rule('$.setup[*].*', { name: { from: 'meta_argument', argument: 'id' }, scope: { literal: 'setup' } }),
      rule('$.setup[*].id', { name: { from: 'value', spelling: 'as_written' }, scope: { literal: 'setup' } }),
    ],
  });
  assert.deepEqual(analyzed.symbols.map((symbol) => symbol.name), ['config', 'alice', 'bob', 'quoted, id', 'after']);
  const alice = analyzed.symbols.find((symbol) => symbol.name === 'alice');
  const line = text.split('\n')[alice.keyRange.start.line];
  assert.equal(line.slice(alice.keyRange.start.character, alice.keyRange.end.character), 'alice');
  assert.deepEqual(alice.documentPath, ['setup', 2, 'game_session(id=[alice, bob], kind=slot)']);
  const after = analyzed.symbols.find((symbol) => symbol.name === 'after');
  assert.deepEqual(after.documentPath, ['setup', 0, 'id']);
  const listed = doc('packages: [mock-messages, { not: scalar }, mock-protos]\n', {
    symbols: [rule('$.packages[*]', { name: { from: 'value', spelling: 'as_written' } })],
  });
  assert.deepEqual(listed.symbols.map((symbol) => [symbol.name, symbol.documentPath]), [
    ['mock-messages', ['packages', 0]],
    ['mock-protos', ['packages', 2]],
  ]);
});

test('path steps that do not match a node produce no symbol', () => {
  const analyzed = doc('a: 1\nitems:\n  - primary: 1\n    other: 2\nkeys:\n  k: [1]\n', {
    symbols: [
      rule('$.missing'),
      rule('$.a.b'),
      rule('$.a.*'),
      rule('$.items[*]'),
      rule('$.a[*].*'),
      rule('$.items[*].*'),
      rule('$.*', { scope: { fromParent: true, visibleFrom: { kind: 'stack' } } }),
      rule('$.keys.k', { name: { from: 'value', spelling: 'as_written' } }),
    ],
  });
  assert.deepEqual(analyzed.symbols.map((symbol) => symbol.name), ['primary', 'other']);
});

test('references are found in each position their rule allows, and refused in the rest', () => {
  const text = [
    'source: ref mocktype.primary.label',
    'strict: local.db.extra',
    'plain: local.db',
    'alone: ${local.db}',
    'note: "use ${local.db} now"',
    'deep: ${ref mocktype.primary}',
    'unknown: ${nope}',
    'tail: ${local.db.more}',
    'free: use thing here',
    '${local.db}: keyed',
    'name ${local.db}-x: keyed',
    'num: 1',
    '',
  ].join('\n');
  const analyzed = doc(text, {
    placeholders: { pattern: '\\$\\{(?<body>[^}]*)\\}' },
    references: [
      reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', ['whole'], {
        trailingText: 'any',
        target: { scope: { group: 'type' }, name: 'name' },
      }),
      reference('^local\\.(?<name>[a-z0-9_]+)', ['whole', 'placeholder', 'placeholder_in_string'], {
        target: { scope: { literal: 'local' }, name: 'name' },
      }),
      reference('use (?<name>[a-z]+)', ['within']),
    ],
  });
  const keyOf = (line) => text.split('\n')[line].split(':')[0];
  const found = analyzed.references.map((ref) => `${ref.position}:${keyOf(ref.range.start.line)}`);
  assert.deepEqual(found.sort(), [
    'placeholder:${local.db}',
    'placeholder:alone',
    'placeholder_in_string:name ${local.db}-x',
    'placeholder_in_string:note',
    'whole:plain',
    'whole:source',
    'within:free',
  ].sort());
  const plain = analyzed.references.find((ref) => ref.position === 'whole' && ref.groups.name === 'db');
  assert.deepEqual(plain.documentPath, ['plain']);
  const problems = analyzed.referenceProblems.map((problem) => problem.message);
  assert.deepEqual(problems.sort(), [
    'a reference matching ^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+) is not allowed as placeholder',
    'unexpected text after the reference',
    'unexpected text after the reference in ${local.db.more}',
    'unknown placeholder ${nope}',
  ].sort());
  assert.equal(analyzed.placeholders.filter((placeholder) => placeholder.valid).length, 4);
});

test('a placeholder reference spans its whole body, the path after the name included', () => {
  const text = 'get: "${setup.login.body.token} x"\n';
  const analyzed = doc(text, {
    placeholders: { pattern: '\\$\\{(?<body>[^}]*)\\}' },
    references: [
      reference('^setup\\.(?<name>[a-z0-9_]+)', ['placeholder_in_string'], {
        trailingText: 'any',
        target: { scope: { literal: 'setup' }, name: 'name' },
      }),
    ],
  });
  const { range } = analyzed.references[0];
  assert.equal(text.slice(range.start.character, range.end.character), 'setup.login.body.token');
});

test('a document with no placeholders block scans no placeholders', () => {
  const analyzed = doc('a: ${local.db}\n', {
    references: [reference('^local\\.(?<name>[a-z]+)', ['placeholder'])],
  });
  assert.deepEqual(analyzed.references, []);
  assert.deepEqual(analyzed.placeholders, []);
});

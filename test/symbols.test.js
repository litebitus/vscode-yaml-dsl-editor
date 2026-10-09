const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../lib/analyze');
const {
  scope,
  declaration,
  reference,
  placeholder,
  markerFunction,
  dslEntry,
  parsedDsl,
} = require('./config-builders');

function doc(text, fields) {
  return analyzeDocument(text, '/repo/mock.yml', parsedDsl(dslEntry('mock', fields)));
}

test('a key names a symbol by a token, spelled as the rule says, in a declared or parent-key scope', () => {
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
    function: markerFunction(),
    scopes: { RESOURCE: scope({ named_by_parent_key: true }), local: scope() },
    declarations: [
      declaration('$.*.*', 'RESOURCE', {
        skip_keys: ['schema_version', 'locals'],
        exclude_candidates: ['defaults'],
        key_token: 'last_word',
        name_spelling: 'dashes_as_underscores',
      }),
      declaration('$.locals.*', 'local', { key_token: 'first_word' }),
    ],
  });
  const names = analyzed.symbols.map((symbol) => `${symbol.scope}:${symbol.name}`);
  assert.deepEqual(names, ['mocktype:primary', 'mocktype:mock_thing_v2', 'local:db', 'local:operator_key']);
  const local = analyzed.symbols.find((symbol) => symbol.name === 'db');
  assert.deepEqual([local.valueText, local.valueIsScalar, local.call], ['mock-value', true, false]);
  assert.equal(analyzed.symbols.find((symbol) => symbol.name === 'operator_key').call, true);
  assert.deepEqual(analyzed.symbols[0].documentPath, ['mocktype', 'primary']);
  assert.deepEqual([analyzed.symbols[0].scopeName, local.scopeName], ['RESOURCE', 'local']);
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
  const fromValue = { name_source: 'value', key_token: null };
  const analyzed = doc(text, {
    scopes: { setup: scope() },
    declarations: [
      declaration('$.setup[*].*', 'setup', { name_source: 'meta_argument', key_token: null, meta_argument_name: 'id' }),
      declaration('$.setup[*].id', 'setup', fromValue),
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
    scopes: { package: scope() },
    declarations: [declaration('$.packages[*]', 'package', fromValue)],
  });
  assert.deepEqual(listed.symbols.map((symbol) => [symbol.name, symbol.documentPath]), [
    ['mock-messages', ['packages', 0]],
    ['mock-protos', ['packages', 2]],
  ]);
});

test('path steps that do not match a node produce no symbol', () => {
  const analyzed = doc('a: 1\nitems:\n  - primary: 1\n    other: 2\nkeys:\n  k: [1]\n', {
    scopes: { thing: scope(), PARENT: scope({ named_by_parent_key: true }) },
    declarations: [
      declaration('$.missing', 'thing'),
      declaration('$.a.b', 'thing'),
      declaration('$.a.*', 'thing'),
      declaration('$.items[*]', 'thing'),
      declaration('$.a[*].*', 'thing'),
      declaration('$.items[*].*', 'thing'),
      declaration('$.*', 'PARENT'),
      declaration('$.keys.k', 'thing', { name_source: 'value', key_token: null }),
    ],
  });
  assert.deepEqual(analyzed.symbols.map((symbol) => symbol.name), ['primary', 'other']);
});

test('a wildcard declares the children of a map or a list alike, and ..* declares at every depth below its path', () => {
  const fromValue = { name_source: 'value', key_token: null };
  const analyzed = doc('packages: [mock-a, mock-b]\nhosts:\n  api: x\n  web: y\ntree:\n  a:\n    b: 1\n  skip:\n    c: 1\n  d: 1\n', {
    scopes: { thing: scope() },
    declarations: [
      declaration('$.packages.*', 'thing', fromValue),
      declaration('$.hosts[*]', 'thing'),
      declaration('$.tree..*', 'thing', { skip_keys: ['skip'], exclude_candidates: ['d'] }),
    ],
  });
  assert.deepEqual(analyzed.symbols.map((symbol) => symbol.name), ['mock-a', 'mock-b', 'api', 'web', 'a', 'b', 'skip']);
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
    placeholder: placeholder(),
    scopes: { RESOURCE: scope({ named_by_parent_key: true }), local: scope(), thing: scope() },
    references: [
      reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', 'RESOURCE', {
        text_after_name_allowed: true,
        scope_group: 'type',
      }),
      reference('^local\\.(?<name>[a-z0-9_]+)', 'local', {
        positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
      }),
      reference('use (?<name>[a-z]+)', 'thing', { positions: ['anywhere_in_scalar'] }),
    ],
  });
  const keyOf = (line) => text.split('\n')[line].split(':')[0];
  const found = analyzed.references.map((ref) => `${ref.position}:${keyOf(ref.range.start.line)}`);
  assert.deepEqual(found.sort(), [
    'whole_placeholder:${local.db}',
    'whole_placeholder:alone',
    'placeholder_in_text:name ${local.db}-x',
    'placeholder_in_text:note',
    'whole_scalar:plain',
    'whole_scalar:source',
    'anywhere_in_scalar:free',
  ].sort());
  const plain = analyzed.references.find((ref) => ref.position === 'whole_scalar' && ref.groups.name === 'db');
  assert.deepEqual(plain.documentPath, ['plain']);
  const problems = analyzed.referenceProblems.map((problem) => problem.message);
  assert.deepEqual(problems.sort(), [
    'a reference matching ^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+) is not allowed as whole_placeholder',
    'unexpected text after the reference',
    'unexpected text after the reference in ${local.db.more}',
    'unknown placeholder ${nope}',
  ].sort());
  assert.equal(analyzed.placeholders.filter((scanned) => scanned.valid).length, 4);
});

test('a placeholder reference spans its whole body, the path after the name included', () => {
  const text = 'get: "${setup.login.body.token} x"\n';
  const analyzed = doc(text, {
    placeholder: placeholder(),
    scopes: { setup: scope() },
    references: [
      reference('^setup\\.(?<name>[a-z0-9_]+)', 'setup', {
        positions: ['placeholder_in_text'],
        text_after_name_allowed: true,
      }),
    ],
  });
  const { range } = analyzed.references[0];
  assert.equal(text.slice(range.start.character, range.end.character), 'setup.login.body.token');
});

test('a reference records the document path it sits at and whether it sits in a key', () => {
  const text = 'mocktype:\n  name_${local.suffix}: local.db\n';
  const analyzed = doc(text, {
    placeholder: placeholder(),
    scopes: { local: scope() },
    references: [
      reference('^local\\.(?<name>[a-z]+)$', 'local', {
        positions: ['whole_scalar', 'placeholder_in_text'],
      }),
    ],
  });
  const located = analyzed.references.map((found) => [found.groups.name, found.documentPath, found.inKey]);
  assert.deepEqual(located, [
    ['suffix', ['mocktype', 'name_${local.suffix}'], true],
    ['db', ['mocktype', 'name_${local.suffix}'], false],
  ]);
});

test('placeholders under an unscanned path are another language\'s text and are not read', () => {
  const text = [
    'build:',
    '  commands:',
    '    - export MOCK=${SHELL_VALUE:0:7}',
    'dockerfile: FROM mock:${MOCK_VERSION}',
    'name: ${nope}',
    '',
  ].join('\n');
  const analyzed = doc(text, {
    placeholder: placeholder({
      unscanned_paths: [
        { path: '$.build', skip_keys: [] },
        { path: '$.build..*', skip_keys: [] },
        { path: '$.dockerfile', skip_keys: [] },
      ],
    }),
  });
  assert.deepEqual(analyzed.placeholders.map((scanned) => scanned.text), ['${nope}']);
  assert.deepEqual(analyzed.referenceProblems.map((problem) => problem.message), ['unknown placeholder ${nope}']);
});

test('a DSL with no placeholder block scans no placeholders', () => {
  const analyzed = doc('a: ${local.db}\n', {
    scopes: { local: scope() },
    references: [reference('^local\\.(?<name>[a-z]+)', 'local', { positions: ['whole_placeholder'] })],
  });
  assert.deepEqual(analyzed.references, []);
  assert.deepEqual(analyzed.placeholders, []);
});

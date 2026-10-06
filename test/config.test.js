const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, claimFile, ownsFile } = require('../lib/config');

const completeConfig = `
dsls:
  - id: resources
    includes: ["**/mock.yml", 1]
    excludes: ["**/skip/**"]
    schema: https://example.test/schema.json
    layers:
      environments: [one, 2]
    placeholders:
      pattern: '\\$\\{(?<body>[^}]*)\\}'
    functions:
      marker: fn.
      splat: '*'
      vocabulary: [terraform, { schema: '#/x-yaml-dsl-functions' }]
      unnamed_calls: sole_key
      call_results_where: [whole]
      refused_at:
        - { at: "$.*", skip: [], subtree: false }
        - { at: "$.cloud", skip: [], subtree: true }
    scopes:
      global: { visible_from: everywhere, names: [env, 1] }
      local: { visible_from: stack }
      step: { visible_from: following }
      setup: { visible_from: ["$.cases", "$.teardown"] }
    symbols:
      - at: "$.locals.*"
        skip: []
        exclude: []
        name: { from: key, token: first, spelling: as_written }
        scope: local
      - at: "$.*.*"
        skip: [locals, 3]
        exclude: [defaults]
        name: { from: key, token: last, spelling: snake }
        scope: { from: parent, visible_from: stack }
      - at: "$.setup[*].*"
        skip: []
        exclude: []
        name: { from: meta_argument, argument: id }
        scope: setup
      - at: "$.setup[*].id"
        skip: []
        exclude: []
        name: { from: value }
        scope: step
    references:
      - pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)'
        where: [whole]
        trailing_text: any
        target: { scope: { group: type }, name: name }
      - pattern: '^local\\.(?<name>[a-z0-9_]+)$'
        where: [whole, placeholder, placeholder_in_string]
        trailing_text: none
        target: { scope: local, name: name }
`;

test('a complete config states every field and keeps them', () => {
  const parsed = parseConfig(completeConfig);
  assert.equal(parsed.error, null);
  const [resources] = parsed.dsls;
  assert.deepEqual(resources.includes, ['**/mock.yml']);
  assert.deepEqual(resources.excludes, ['**/skip/**']);
  assert.deepEqual(resources.schema, ['https://example.test/schema.json']);
  assert.deepEqual(resources.layers.environments, ['one']);
  assert.equal(resources.placeholders.pattern, '\\$\\{(?<body>[^}]*)\\}');
  assert.deepEqual(resources.functions.vocabulary, [
    { source: 'terraform' },
    { source: 'schema', pointer: '#/x-yaml-dsl-functions' },
  ]);
  assert.equal(resources.functions.unnamedCalls, 'sole_key');
  assert.deepEqual(resources.functions.callResultsWhere, ['whole']);
  assert.equal(resources.functions.refusedAt[1].subtree, true);
  assert.deepEqual(resources.scopes.global, { visibleFrom: { kind: 'everywhere' }, names: ['env'] });
  assert.equal(resources.scopes.setup.visibleFrom.kind, 'paths');
  assert.equal(resources.scopes.step.visibleFrom.kind, 'following');
  assert.deepEqual(resources.symbols.map((symbol) => symbol.name.from), ['key', 'key', 'meta_argument', 'value']);
  assert.deepEqual(resources.symbols[1].scope, { fromParent: true, visibleFrom: { kind: 'stack' } });
  assert.deepEqual(resources.symbols[1].skip, ['locals']);
  assert.deepEqual(resources.references[0].target, { scope: { group: 'type' }, name: 'name' });
  assert.equal(resources.references[1].trailingText, 'none');
});

test('a config that leaves a field out is a problem, and the editor fills nothing in', () => {
  const parsed = parseConfig(`
dsls:
  - id: bare
    symbols:
      - at: "$.a.*"
      - { at: bad }
      - 1
      - at: "$.b.*"
        skip: []
        exclude: []
        name: { from: meta_argument }
        scope: undeclared
      - at: "$.c.*"
        skip: []
        exclude: []
        name: 1
        scope: { from: parent }
      - at: "$.d.*"
        skip: []
        exclude: []
        name: { from: key, token: middle, spelling: snake }
        scope: { from: parent, visible_from: nowhere }
    references:
      - pattern: '^x'
      - pattern: '('
      - 1
      - pattern: '^y'
        where: [sideways]
        trailing_text: maybe
        target: { scope: 1 }
      - pattern: '^z'
        where: []
        trailing_text: none
    scopes:
      broken: 1
      unseen: { visible_from: [bad] }
    functions:
      vocabulary: [elsewhere]
      call_results_where: [nowhere]
      refused_at: [{ at: bad }, { at: "$.x", skip: 1, subtree: 1 }]
  - id: blocks
    includes: ["**/b.yml"]
    excludes: []
    schema: 1
    layers: 1
    placeholders: { pattern: '\\$\\{[^}]*\\}' }
    functions: 1
    scopes: 1
    symbols: []
    references: []
  - id: unused
    includes: []
    excludes: []
    schema: []
    layers: none
    placeholders: none
    functions: none
    scopes: {}
    symbols: []
    references: []
  - { includes: ["**/*.yml"] }
`);
  assert.equal(parsed.ok, false);
  const expected = [
    'bare.includes is required',
    'bare.excludes is required',
    'bare.scopes.broken must be a mapping',
    'bare.scopes.unseen.visible_from is required',
    'bare.symbols[0].skip is required',
    'bare.symbols[0].name is required',
    'bare.symbols[0].scope is required',
    'bare.symbols[1].at is required',
    'bare.symbols[2] must be a mapping',
    'bare.symbols[3].name.argument is required',
    'bare.symbols[4].scope.visible_from is required',
    'bare.symbols[5].name.token must be one of whole, first, last',
    'bare.references[0].where is required',
    'bare.references[0].trailing_text is required',
    'bare.references[0].target is required',
    'bare.references[1].pattern is required',
    'bare.references[2] must be a mapping',
    'bare.references[3].where takes whole, placeholder, placeholder_in_string, within',
    'bare.references[3].trailing_text must be one of none, any',
    'bare.references[3].target.scope is required',
    'bare.references[3].target.name is required',
    'bare.references[4].target is required',
    'bare.placeholders is required',
    'bare.functions.marker is required',
    'bare.functions.splat is required',
    'bare.functions.vocabulary is required',
    'bare.functions.unnamed_calls is required',
    'bare.functions.call_results_where is required',
    'bare.functions.refused_at[0].at is required',
    'bare.functions.refused_at[1].skip is required',
    'bare.functions.refused_at[1].subtree is required',
    'bare.schema is required',
    'bare.layers is required',
    'blocks.schema is required',
    'blocks.layers is required',
    "blocks.placeholders.pattern must name the placeholder's body",
    'blocks.functions is required',
    'blocks.scopes is required',
  ];
  for (const message of expected) assert.ok(parsed.error.includes(message), message);
  const [bare, blocks, unused] = parsed.dsls;
  assert.deepEqual(bare.symbols, []);
  assert.deepEqual(bare.references, []);
  assert.equal(blocks.placeholders, null);
  assert.deepEqual(unused.schema, []);
  assert.equal(unused.layers, null);
  assert.equal(unused.placeholders, null);
  assert.equal(unused.functions, null);
  const listsMissing = parseConfig('dsls:\n  - id: one\n    symbols: 1\n    references: 1\n');
  assert.equal(listsMissing.error.includes('one.symbols is required'), true);
  const patternBroken = parseConfig('dsls:\n  - id: two\n    placeholders: { pattern: "(" }\n');
  assert.equal(patternBroken.error.includes('two.placeholders.pattern is required'), true);
});

test('deprecated forms are read and reported, each naming its replacement', () => {
  const parsed = parseConfig(`
dsls:
  - id: old
    match: ["**/mock.yml"]
    placeholders:
      pattern: '\\$\\{(?<body>[^}]*)\\}'
      builtins: [env]
      references: [local, ref]
    symbols:
      - kind: local
        at: "$.locals.*"
        name: { from: key }
      - kind: resource
        at: "$.*.*"
        skip: [locals]
        name: { token: last, spelling: snake }
        qualify: { type: parent }
      - kind: thing
        at: "$.things.*"
        name: { token: first }
    references:
      - pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)'
        where: whole
        target: { kind: resource, type: type, name: name }
      - pattern: '^local\\.(?<name>[a-z0-9_]+)$'
        where: whole
        target: { kind: local, name: name }
      - pattern: 'use (?<name>[a-z]+)'
        where: within
        target: { kind: thing, name: name }
`);
  for (const message of [
    'old.match is deprecated: write includes',
    'old.symbols[0]: kind and qualify are deprecated: write scope',
    'old.references[0]: target.kind and a single where are deprecated',
    'old.placeholders: builtins and references are deprecated',
  ]) assert.ok(parsed.error.includes(message), message);
  const [old] = parsed.dsls;
  assert.deepEqual(old.includes, ['**/mock.yml']);
  assert.deepEqual(old.symbols.map((symbol) => symbol.scope), [
    { literal: 'local' },
    { fromParent: true, visibleFrom: { kind: 'stack' } },
    { literal: 'thing' },
  ]);
  assert.deepEqual(old.symbols[0].name, { from: 'key', token: 'whole', spelling: 'as_written' });
  assert.deepEqual(old.symbols[2].name.token, 'first');
  assert.deepEqual(old.references[0].where, ['whole', 'placeholder', 'placeholder_in_string']);
  assert.deepEqual(old.references[0].target, { scope: { group: 'type' }, name: 'name' });
  assert.deepEqual(old.references[1].where, ['whole', 'placeholder', 'placeholder_in_string']);
  assert.deepEqual(old.references[2].where, ['within']);
  assert.equal(old.references[3].target.scope.literal, 'global');
  assert.deepEqual(old.scopes.global.names, ['env']);
  assert.equal(old.scopes.local.visibleFrom.kind, 'stack');
  assert.equal(old.scopes.thing.visibleFrom.kind, 'stack');
  const both = parseConfig('dsls:\n  - id: both\n    match: ["**/a.yml"]\n    includes: ["**/b.yml"]\n');
  assert.deepEqual(both.dsls[0].includes, ['**/b.yml']);
});

test('a config that is not a mapping is rejected', () => {
  assert.equal(parseConfig('[').ok, false);
  assert.equal(parseConfig('[]').ok, false);
  assert.equal(parseConfig('').ok, false);
  assert.equal(parseConfig('name: only').dsls.length, 0);
  assert.equal(parseConfig('dsls: 1').dsls.length, 0);
});

test('includes and excludes decide the files a DSL owns, and two owners claim nothing', () => {
  const owner = (id, includes, excludes = []) => ({ id, includes, excludes });
  const suites = owner('suites', ['**/*.yml'], ['**/.github/**', '**/protocols/**']);
  assert.equal(ownsFile(suites, '/repo/games/slot-api.yml'), true);
  assert.equal(ownsFile(suites, '/repo/.github/workflows/test.yml'), false);
  assert.equal(ownsFile(suites, '/repo/protocols/mock/protocol.yml'), false);
  assert.equal(claimFile('/repo/protocols/mock/protocol.yml', [{ ...suites, dir: '/repo' }]).status, 'none');
  const claim = claimFile('/repo/mock.yml', [owner('a', ['**/*.yml']), owner('b', ['**/mock.yml'])]);
  assert.equal(claim.status, 'many');
  assert.deepEqual(claim.ids, ['a', 'b']);
  const shared = owner('resources', ['**/resources.yml']);
  const here = claimFile('/repo/a/resources.yml', [{ ...shared, dir: '/repo/a' }, { ...shared, dir: '/repo/b' }]);
  assert.equal(here.status, 'one');
  assert.equal(here.dsl.dir, '/repo/a');
  assert.equal(claimFile('/repo/c/resources.yml', [{ ...shared, dir: '/repo/a' }]).status, 'none');
  assert.equal(claimFile('/repo-a/resources.yml', [{ ...shared, dir: '/repo' }]).status, 'none');
  assert.equal(claimFile('/repo/a/resources.yml', [{ ...shared, dir: '/' }]).status, 'none');
  assert.equal(claimFile('/repo/readme.md', [{ ...shared, dir: '/repo' }]).status, 'none');
});

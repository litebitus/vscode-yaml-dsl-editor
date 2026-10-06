const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, claimFile, ownsFile } = require('../lib/config');

const configText = `
dsls:
  - id: resources
    includes: ["**/mock.yml", 1]
    schema: https://example.test/schema.json
    layers:
      environments: [one, 2]
    symbols:
      - kind: local
        at: "$.locals.*"
        name: { from: key }
      - kind: resource
        at: "$.*.*"
        skip: [defaults, 3]
        exclude: [defaults]
        name: { token: last, spelling: snake }
        qualify: { type: parent, other: nope }
      - { kind: 1 }
      - { at: "$.a" }
    references:
      - pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)'
        where: whole
        target: { kind: resource, type: type, name: name, extra: 1 }
      - pattern: '('
        where: whole
        target: { kind: local, name: name }
      - pattern: x
        where: sideways
        target: { kind: local, name: name }
      - { pattern: 1 }
  - { includes: ["**/*.yml"] }
  - id: pipelines
    includes: ["**/pipelines.yml"]
    symbols: 1
    references: 1
`;

test('a config keeps the rules the editor can apply', () => {
  const parsed = parseConfig(configText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dsls.length, 2);
  const resources = parsed.dsls[0];
  assert.deepEqual(resources.includes, ['**/mock.yml']);
  assert.deepEqual(resources.layers.environments, ['one']);
  assert.equal(resources.symbols.length, 2);
  assert.equal(resources.symbols[1].name.token, 'last');
  assert.equal(resources.symbols[1].name.spelling, 'snake');
  assert.deepEqual(resources.symbols[1].qualify, { type: 'parent' });
  assert.equal(resources.references.length, 1);
  assert.equal(resources.references[0].target.extra, undefined);
  assert.equal(parsed.dsls[1].layers, null);
  assert.deepEqual(parsed.dsls[1].schema, []);
  assert.deepEqual(resources.schema, ['https://example.test/schema.json']);
});

test('a config that is not a mapping is rejected', () => {
  assert.equal(parseConfig('[').ok, false);
  assert.equal(parseConfig('[]').ok, false);
  assert.equal(parseConfig('').ok, false);
  assert.equal(parseConfig('name: only').dsls.length, 0);
  assert.equal(parseConfig('dsls: 1').dsls.length, 0);
  const bare = parseConfig('dsls:\n  - id: plain\n');
  assert.equal(bare.dsls[0].id, 'plain');
  assert.deepEqual(bare.dsls[0].symbols, []);
});

test('a file is claimed by one DSL, neither, or reported when two match', () => {
  const { dsls } = parseConfig(configText);
  assert.equal(claimFile('/repo/mock/mock.yml', dsls).status, 'one');
  assert.equal(claimFile('/repo/readme.md', dsls).status, 'none');
  const both = parseConfig(`
dsls:
  - id: a
    includes: ["**/*.yml"]
  - id: b
    includes: ["**/mock.yml"]
`);
  const claim = claimFile('/repo/mock.yml', both.dsls);
  assert.equal(claim.status, 'many');
  assert.deepEqual(claim.ids, ['a', 'b']);
  const shared = parseConfig(`
dsls:
  - id: resources
    includes: ["**/resources.yml"]
`).dsls[0];
  const here = claimFile('/repo/a/resources.yml', [{ ...shared, dir: '/repo/a' }, { ...shared, dir: '/repo/b' }]);
  assert.equal(here.status, 'one');
  assert.equal(here.dsl.dir, '/repo/a');
  assert.equal(claimFile('/repo/c/resources.yml', [{ ...shared, dir: '/repo/a' }]).status, 'none');
  assert.equal(claimFile('/repo-a/resources.yml', [{ ...shared, dir: '/repo' }]).status, 'none');
  assert.equal(claimFile('/repo/a', [{ ...shared, dir: '/repo/a', includes: ['**/*'], excludes: [] }]).status, 'one');
  assert.equal(claimFile('/repo/a/resources.yml', [{ ...shared, dir: '/' }]).status, 'none');
});

test('a placeholders block names its body group, its builtins, and the references a body may be', () => {
  const block = (placeholders) => parseConfig(`dsls:\n  - id: mock\n    includes: ["**/mock.yml"]\n    placeholders: ${placeholders}\n`);
  const good = block("{ pattern: '\\$\\{(?<body>[^}]*)\\}', builtins: [env, region], references: [local, ref] }");
  assert.equal(good.ok, true);
  assert.deepEqual(good.dsls[0].placeholders, {
    pattern: '\\$\\{(?<body>[^}]*)\\}',
    builtins: ['env', 'region'],
    references: ['local', 'ref'],
  });
  assert.equal(parseConfig('dsls:\n  - id: mock\n    includes: ["**/mock.yml"]\n').dsls[0].placeholders, null);
  assert.match(block('[a]').error, /mock\.placeholders must be a mapping/);
  assert.match(block('{ builtins: [env] }').error, /pattern must be a regular expression/);
  assert.match(block("{ pattern: '(' }").error, /pattern must be a regular expression/);
  assert.match(block("{ pattern: '\\$\\{[^}]*\\}' }").error, /\(\?<body>\.\.\.\) group/);
  const unknown = block("{ pattern: '\\$\\{(?<body>[^}]*)\\}', references: [local, resource] }");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /references takes local and ref: resource/);
  assert.deepEqual(unknown.dsls[0].placeholders.references, ['local']);
});

test('includes and excludes decide the files a DSL owns, and match is read as deprecated', () => {
  const parsed = parseConfig('dsls:\n  - id: suites\n    includes: ["**/*.yml"]\n    excludes: ["**/.github/**", "**/protocols/**"]\n');
  assert.equal(parsed.ok, true);
  const [suites] = parsed.dsls;
  assert.equal(ownsFile(suites, '/repo/games/slot-api.yml'), true);
  assert.equal(ownsFile(suites, '/repo/.github/workflows/test.yml'), false);
  assert.equal(ownsFile(suites, '/repo/protocols/mock/protocol.yml'), false);
  assert.equal(claimFile('/repo/protocols/mock/protocol.yml', [{ ...suites, dir: '/repo' }]).status, 'none');
  const legacy = parseConfig('dsls:\n  - id: old\n    match: ["**/mock.yml"]\n');
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /old\.match is deprecated: write includes/);
  assert.deepEqual(legacy.dsls[0].includes, ['**/mock.yml']);
  const both = parseConfig('dsls:\n  - id: both\n    match: ["**/a.yml"]\n    includes: ["**/b.yml"]\n');
  assert.deepEqual(both.dsls[0].includes, ['**/b.yml']);
});

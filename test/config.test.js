const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, claimFile } = require('../lib/config');

const configText = `
dsls:
  - id: resources
    match: ["**/mock.yml", 1]
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
  - { match: ["**/*.yml"] }
  - id: pipelines
    match: ["**/pipelines.yml"]
    symbols: 1
    references: 1
`;

test('a config keeps the rules the editor can apply', () => {
  const parsed = parseConfig(configText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dsls.length, 2);
  const resources = parsed.dsls[0];
  assert.deepEqual(resources.match, ['**/mock.yml']);
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
    match: ["**/*.yml"]
  - id: b
    match: ["**/mock.yml"]
`);
  const claim = claimFile('/repo/mock.yml', both.dsls);
  assert.equal(claim.status, 'many');
  assert.deepEqual(claim.ids, ['a', 'b']);
});

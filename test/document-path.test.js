const test = require('node:test');
const assert = require('node:assert/strict');
const { PATH_STEP_KINDS, parseAt, pathMatches } = require('../lib/document-path');

test('a path parses the RFC 9535 subset: $, .name, .* and [*] alike, and a final ..*', () => {
  assert.deepEqual(parseAt('$'), []);
  assert.deepEqual(parseAt('$.cases[*].id'), [
    { kind: PATH_STEP_KINDS.name, key: 'cases' },
    { kind: PATH_STEP_KINDS.wildcard },
    { kind: PATH_STEP_KINDS.name, key: 'id' },
  ]);
  assert.deepEqual(parseAt('$.*'), parseAt('$[*]'));
  assert.deepEqual(parseAt('$.build..*'), [{ kind: PATH_STEP_KINDS.name, key: 'build' }, { kind: PATH_STEP_KINDS.descendants }]);
  for (const invalid of ['', 'build', '$.', '$..*.name', '$..*..*', '$[0]', 1]) assert.equal(parseAt(invalid), null, invalid);
});

test('a wildcard selects every child of a map or a list, and skip_keys passes over the keys it lists', () => {
  const wildcard = parseAt('$.*');
  assert.equal(pathMatches(wildcard, ['queue']), true);
  assert.equal(pathMatches(wildcard, [0]), true);
  assert.equal(pathMatches(wildcard, ['locals'], { skipKeys: ['locals'] }), false);
  assert.equal(pathMatches(wildcard, ['queue', 'events']), false);
  assert.equal(pathMatches(parseAt('$'), []), true);
});

test('..* selects every node below its path but not the path itself, and not below a skipped key', () => {
  const descendants = parseAt('$.build..*');
  assert.equal(pathMatches(descendants, ['build']), false);
  assert.equal(pathMatches(descendants, ['build', 'commands']), true);
  assert.equal(pathMatches(descendants, ['build', 'commands', 0]), true);
  assert.equal(pathMatches(descendants, ['other', 'commands']), false);
  const everything = parseAt('$..*');
  assert.equal(pathMatches(everything, []), false);
  assert.equal(pathMatches(everything, ['locals', 'name'], { skipKeys: ['locals'] }), false);
  assert.equal(pathMatches(everything, ['queue', 'events'], { skipKeys: ['locals'] }), true);
});

test('a region covers the subtree of each node its path selects', () => {
  assert.equal(pathMatches(parseAt('$.cases'), ['cases', 0, 'id'], { includesSubtree: true }), true);
  assert.equal(pathMatches(parseAt('$.cases'), ['setup', 0], { includesSubtree: true }), false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverStack, environmentOf } = require('../lib/discover');

const envs = ['one', 'two', 'three', 'four'];

test('an overlay and a family file find the same common layer', () => {
  const overlay = discoverStack('/repo/mock-stack/one/mock.yml', envs);
  assert.equal(overlay.common, '/repo/mock-stack/mock.yml');
  assert.equal(overlay.activeEnv, 'one');
  assert.equal(overlay.overlays.four, '/repo/mock-stack/four/mock.yml');
  const family = discoverStack('/repo/mock-family/mock.yml', envs);
  assert.equal(family.common, '/repo/mock-family/mock.yml');
  assert.equal(family.activeEnv, null);
  assert.equal(family.overlays.two, '/repo/mock-family/two/mock.yml');
  assert.equal(environmentOf(overlay.overlays.one, overlay), 'one');
  assert.equal(environmentOf(overlay.common, overlay), null);
});

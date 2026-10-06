const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverStack, overlayNameOf } = require('../lib/discover');

const overlayNames = ['one', 'two', 'three', 'four'];

test('an overlay and a family file find the same common layer', () => {
  const overlay = discoverStack('/repo/mock-stack/one/mock.yml', overlayNames);
  assert.equal(overlay.common, '/repo/mock-stack/mock.yml');
  assert.equal(overlay.activeOverlay, 'one');
  assert.equal(overlay.overlays.four, '/repo/mock-stack/four/mock.yml');
  const family = discoverStack('/repo/mock-family/mock.yml', overlayNames);
  assert.equal(family.common, '/repo/mock-family/mock.yml');
  assert.equal(family.activeOverlay, null);
  assert.equal(family.overlays.two, '/repo/mock-family/two/mock.yml');
  assert.equal(overlayNameOf(overlay.overlays.one, overlay), 'one');
  assert.equal(overlayNameOf(overlay.common, overlay), null);
});

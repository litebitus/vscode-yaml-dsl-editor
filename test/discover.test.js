const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverStack, overlayNameOf } = require('../lib/discover');

const overlayNames = ['one', 'two', 'three', 'four'];
const parentLayers = { overlayFolders: overlayNames, commonLayerDiscovery: 'parent' };
const ancestorLayers = { overlayFolders: overlayNames, commonLayerDiscovery: 'ancestor' };
const root = '/repo';

test('an overlay and a family file find the same common layer', () => {
  for (const layers of [parentLayers, ancestorLayers]) {
    const overlay = discoverStack('/repo/mock-stack/one/mock.yml', layers, root);
    assert.equal(overlay.common, '/repo/mock-stack/mock.yml');
    assert.equal(overlay.activeOverlay, 'one');
    assert.equal(overlay.overlays.four, '/repo/mock-stack/four/mock.yml');
    const family = discoverStack('/repo/mock-family/mock.yml', layers, root);
    assert.equal(family.common, '/repo/mock-family/mock.yml');
    assert.equal(family.activeOverlay, null);
    assert.equal(family.overlays.two, '/repo/mock-family/two/mock.yml');
    assert.equal(overlayNameOf(overlay.overlays.one, overlay), 'one');
    assert.equal(overlayNameOf(overlay.common, overlay), null);
  }
});

test('ancestor takes the common layer directly above the nearest overlay folder', () => {
  const nested = discoverStack('/repo/mock-stack/one/config/mock.yml', ancestorLayers, root);
  assert.equal(nested.common, '/repo/mock-stack/mock.yml');
  assert.equal(nested.activeOverlay, 'one');
  assert.equal(nested.overlays.two, '/repo/mock-stack/two/config/mock.yml');
  assert.equal(nested.id, '/repo/mock-stack/mock.yml#config');
  assert.notEqual(nested.id, discoverStack('/repo/mock-stack/one/mock.yml', ancestorLayers, root).id);
  const unrelated = discoverStack('/repo/mock-stack/build/mock.yml', ancestorLayers, root);
  assert.equal(unrelated.common, '/repo/mock-stack/build/mock.yml');
  assert.equal(unrelated.activeOverlay, null);
  assert.equal(discoverStack('/one/mock.yml', ancestorLayers, '/').common, '/mock.yml');
});

test('a directory above the workspace folder is never an overlay directory', () => {
  const inside = discoverStack('/home/one/repo/mock-stack/mock.yml', ancestorLayers, '/home/one/repo');
  assert.equal(inside.common, '/home/one/repo/mock-stack/mock.yml');
  assert.equal(inside.activeOverlay, null);
  const outside = discoverStack('/elsewhere/one/mock.yml', ancestorLayers, '/home/one/repo');
  assert.equal(outside.activeOverlay, null);
});

test('parent takes the common layer only from the directory above the file\'s own', () => {
  const nested = discoverStack('/repo/mock-stack/one/config/mock.yml', parentLayers, root);
  assert.equal(nested.common, '/repo/mock-stack/one/config/mock.yml');
  assert.equal(nested.activeOverlay, null);
  assert.equal(nested.overlays.two, '/repo/mock-stack/one/config/two/mock.yml');
});

const concernLayers = {
  ...ancestorLayers,
  commonLayerFiles: { 'mock.yml': ['{concern}.mock.yml', 'mock-common.yml', 'mock.yml'] },
};

test('a file below an overlay folder tries its concern\'s common layer first, then the plain names in order', () => {
  const nested = discoverStack('/repo/mock-stack/one/config/mock.yml', concernLayers, root);
  assert.deepEqual(nested.commonCandidates, [
    '/repo/mock-stack/config.mock.yml',
    '/repo/mock-stack/mock-common.yml',
    '/repo/mock-stack/mock.yml',
  ]);
  assert.equal(nested.common, '/repo/mock-stack/config.mock.yml');
  assert.equal(nested.id, '/repo/mock-stack/mock.yml#config');
  const deeper = discoverStack('/repo/mock-stack/one/inner/config/mock.yml', concernLayers, root);
  assert.equal(deeper.commonCandidates[0], '/repo/mock-stack/config.mock.yml');
  assert.equal(deeper.overlays.two, '/repo/mock-stack/two/inner/config/mock.yml');
});

test('a file directly in an overlay folder skips the concern names', () => {
  const direct = discoverStack('/repo/mock-stack/one/mock.yml', concernLayers, root);
  assert.deepEqual(direct.commonCandidates, ['/repo/mock-stack/mock-common.yml', '/repo/mock-stack/mock.yml']);
  assert.equal(direct.id, '/repo/mock-stack/mock.yml');
});

test('a common layer name opened itself finds the stack its overlays find', () => {
  const concern = discoverStack('/repo/mock-stack/config.mock.yml', concernLayers, root);
  const overlay = discoverStack('/repo/mock-stack/one/config/mock.yml', concernLayers, root);
  assert.equal(concern.id, overlay.id);
  assert.deepEqual(concern.overlays, overlay.overlays);
  assert.equal(concern.activeOverlay, null);
  const plain = discoverStack('/repo/mock-stack/mock-common.yml', concernLayers, root);
  assert.equal(plain.id, '/repo/mock-stack/mock.yml');
  assert.equal(plain.overlays.one, '/repo/mock-stack/one/mock.yml');
  const keyed = discoverStack('/repo/mock-stack/mock.yml', concernLayers, root);
  assert.equal(keyed.id, '/repo/mock-stack/mock.yml');
  const unlisted = discoverStack('/repo/mock-stack/other.yml', concernLayers, root);
  assert.deepEqual(unlisted.commonCandidates, ['/repo/mock-stack/other.yml']);
});

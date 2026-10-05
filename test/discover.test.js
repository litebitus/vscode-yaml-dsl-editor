const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverStack, environmentOf } = require('../lib/discover');

const envs = ['dev', 'staging', 'uat', 'production'];

test('an overlay and a family file find the same common layer', () => {
  const overlay = discoverStack('/repo/rds/datahub/dev/resources.yml', envs);
  assert.equal(overlay.common, '/repo/rds/datahub/resources.yml');
  assert.equal(overlay.activeEnv, 'dev');
  assert.equal(overlay.overlays.production, '/repo/rds/datahub/production/resources.yml');
  const family = discoverStack('/repo/security-group-rule/resources.yml', envs);
  assert.equal(family.common, '/repo/security-group-rule/resources.yml');
  assert.equal(family.activeEnv, null);
  assert.equal(family.overlays.staging, '/repo/security-group-rule/staging/resources.yml');
  assert.equal(environmentOf(overlay.overlays.dev, overlay), 'dev');
  assert.equal(environmentOf(overlay.common, overlay), null);
});

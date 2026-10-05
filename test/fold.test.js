const test = require('node:test');
const assert = require('node:assert/strict');
const { foldDocument } = require('../lib/fold');

test('a fold is the common layer under the overlay', () => {
  const present = foldDocument('dev', { redshift: { primary: { name: 'a', old: 1 } } }, { redshift: { primary: { old: null, name: 'b' } } }, true);
  assert.equal(present.value.redshift.primary.name, 'b');
  assert.equal(present.value.redshift.primary.old, undefined);
  assert.match(present.text, /^# dev — common layer merged with dev\/resources.yml/);
  const missing = foldDocument('staging', { redshift: { primary: { name: 'a' } } }, null, false);
  assert.equal(missing.value.redshift.primary.name, 'a');
  assert.match(missing.text, /the common layer/);
  const empty = foldDocument('uat', { redshift: { primary: { name: 'a' } } }, { redshift: { primary: {} } }, true);
  assert.equal(empty.value.redshift.primary.name, 'a');
  const blank = foldDocument('dev', null, null, true);
  assert.deepEqual(blank.value, {});
});

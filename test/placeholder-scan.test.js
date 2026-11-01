const test = require('node:test');
const assert = require('node:assert/strict');
const { holdsPlaceholder, scanPlaceholders } = require('../lib/placeholder-scan');

const localRule = {
  pattern: '^local\\.(?<name>[a-z_]+)',
  positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
  textAfterNameAllowed: true,
};
const placeholder = { pattern: '\\$\\{(?<body>[^}]*)\\}', escapePrefix: '$', unscannedPaths: [] };

test('a placeholder after the escape prefix is text and is not scanned', () => {
  const found = scanPlaceholders('echo $${HOME} ${local.name}', placeholder, [localRule]);
  assert.deepEqual(found.map((scanned) => scanned.text), ['${local.name}']);
  assert.equal(holdsPlaceholder('echo $${HOME}', placeholder), false);
  assert.equal(holdsPlaceholder('echo ${local.name}', placeholder), true);
});

test('without an escape prefix every placeholder is scanned', () => {
  const unescaped = { ...placeholder, escapePrefix: null };
  const found = scanPlaceholders('echo $${HOME}', unescaped, [localRule]);
  assert.deepEqual(found.map((scanned) => scanned.text), ['${HOME}']);
});

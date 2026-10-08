const test = require('node:test');
const assert = require('node:assert/strict');
const { hasUnreleasedHeading, releasedChangelogText, localDateOf } = require('../scripts/changelog-release');

const mockChangelog = '# Changelog\n\n## Unreleased\n\n- Mock change.\n\n## 0.1.0\n\n- Mock old change.\n';

test('the unreleased heading becomes the released version and its date, and nothing else changes', () => {
  assert.equal(
    releasedChangelogText(mockChangelog, '9.8.7', '2026-01-02'),
    '# Changelog\n\n## 9.8.7 - 2026-01-02\n\n- Mock change.\n\n## 0.1.0\n\n- Mock old change.\n',
  );
});

test('a changelog without an unreleased heading cannot be released', () => {
  const released = mockChangelog.replace('## Unreleased', '## 9.8.7 - 2026-01-02');
  assert.equal(hasUnreleasedHeading(released), false);
  assert.equal(hasUnreleasedHeading(mockChangelog), true);
  assert.throws(() => releasedChangelogText(released, '9.8.8', '2026-01-03'), /no "## Unreleased" heading/);
  assert.equal(hasUnreleasedHeading('# Changelog\n\n### Unreleased\n'), false);
});

test('the release date is the local calendar date, zero-padded', () => {
  assert.equal(localDateOf(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localDateOf(new Date(2026, 10, 15, 0, 1)), '2026-11-15');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { WARNING_BADGE, WARNING_THEME_COLOR, warningFileDecoration } = require('../lib/warning-files');

const fakeVscode = {
  FileDecoration: class {
    constructor(badge, tooltip, color) {
      this.badge = badge;
      this.tooltip = tooltip;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) { this.id = id; }
  },
};

const uriOf = (text) => ({ toString: () => text });

test('a file holding a warning takes the warning color and badge, and every folder above it the warning color', () => {
  const warningFileUris = ['file:///repo/dev/mock.yml'];
  const file = warningFileDecoration(fakeVscode, warningFileUris, uriOf('file:///repo/dev/mock.yml'));
  assert.deepEqual([file.badge, file.color.id, file.propagate], [WARNING_BADGE, WARNING_THEME_COLOR, true]);
  for (const folder of ['file:///repo/dev', 'file:///repo']) {
    const decoration = warningFileDecoration(fakeVscode, warningFileUris, uriOf(folder));
    assert.deepEqual([decoration.badge, decoration.color.id, decoration.propagate], [undefined, WARNING_THEME_COLOR, undefined]);
  }
  assert.equal(warningFileDecoration(fakeVscode, warningFileUris, uriOf('file:///repo/staging/mock.yml')), undefined);
  assert.equal(warningFileDecoration(fakeVscode, warningFileUris, uriOf('file:///repo/de')), undefined);
});

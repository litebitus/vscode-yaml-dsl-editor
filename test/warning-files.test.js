const test = require('node:test');
const assert = require('node:assert/strict');
const { WARNING_BADGE, warningFileDecoration } = require('../lib/warning-files');
const { explorerUriSets } = require('../lib/explorer-folders');

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

test('a file holding a warning takes the theme\'s warning color and badge, and every folder above it the color', () => {
  const warningFileUris = explorerUriSets(['file:///repo/dev/mock.yml']);
  const warningColor = 'yamlDslEditor.dark.warningForeground';
  const file = warningFileDecoration(fakeVscode, 'dark', warningFileUris, uriOf('file:///repo/dev/mock.yml'));
  assert.deepEqual([file.badge, file.color.id, file.propagate], [WARNING_BADGE, warningColor, true]);
  for (const folder of ['file:///repo/dev', 'file:///repo']) {
    const decoration = warningFileDecoration(fakeVscode, 'dark', warningFileUris, uriOf(folder));
    assert.deepEqual([decoration.badge, decoration.color.id, decoration.propagate], [undefined, warningColor, undefined]);
  }
  const light = warningFileDecoration(fakeVscode, 'light', warningFileUris, uriOf('file:///repo/dev/mock.yml'));
  assert.equal(light.color.id, 'yamlDslEditor.light.warningForeground');
  assert.equal(warningFileDecoration(fakeVscode, 'dark', warningFileUris, uriOf('file:///repo/staging/mock.yml')), undefined);
  assert.equal(warningFileDecoration(fakeVscode, 'dark', warningFileUris, uriOf('file:///repo/de')), undefined);
});

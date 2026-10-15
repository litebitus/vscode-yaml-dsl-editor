const test = require('node:test');
const assert = require('node:assert/strict');
const { WARNING_BADGE, WARNING_THEME_COLOR, createWarningFiles } = require('../lib/warning-files');

const mockVscode = {
  FileDecoration: class {
    constructor(badge, tooltip, color) {
      Object.assign(this, { badge, tooltip, color });
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
};

const uriOf = (text) => ({ toString: () => text });

test('a stack report names the files holding a warning, and a later report replaces it', () => {
  const warningFiles = createWarningFiles();
  assert.deepEqual(warningFiles.replaceStack('/repo/mock.yml', ['file:///repo/dev/mock.yml']), [
    'file:///repo/dev/mock.yml',
  ]);
  const decoration = warningFiles.fileDecoration(mockVscode, uriOf('file:///repo/dev/mock.yml'));
  assert.deepEqual([decoration.badge, decoration.color.id, decoration.propagate], [WARNING_BADGE, WARNING_THEME_COLOR, true]);
  assert.equal(warningFiles.fileDecoration(mockVscode, uriOf('file:///repo/staging/mock.yml')), undefined);
  const changed = warningFiles.replaceStack('/repo/mock.yml', ['file:///repo/staging/mock.yml']);
  assert.deepEqual(changed.sort(), ['file:///repo/dev/mock.yml', 'file:///repo/staging/mock.yml']);
  assert.equal(warningFiles.holdsWarning('file:///repo/dev/mock.yml'), false);
  assert.equal(warningFiles.holdsWarning('file:///repo/staging/mock.yml'), true);
});

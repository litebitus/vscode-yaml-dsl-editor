const test = require('node:test');
const assert = require('node:assert/strict');
const { validatorFileDecoration } = require('../lib/validator-files');
const { WARNING_BADGE } = require('../lib/warning-files');
const { explorerUriSets } = require('../lib/explorer-folders');

const fakeVscode = {
  FileDecoration: class {
    constructor(badge, tooltip, color) {
      this.badge = badge;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) { this.id = id; }
  },
};

const uriOf = (text) => ({ toString: () => text });

test('a file holding a validation error takes the badge and the theme\'s color of the error severity, its folders the color', () => {
  const uriSets = explorerUriSets(['file:///repo/dev/mock.yml']);
  const decorationOf = (theme, errorSeverity, uri) => {
    const decoration = validatorFileDecoration(fakeVscode, theme, errorSeverity, uriSets, uriOf(uri));
    return [decoration.badge, decoration.color.id];
  };
  const file = 'file:///repo/dev/mock.yml';
  assert.deepEqual(decorationOf('dark', 'error', file), ['✖', 'yamlDslEditor.dark.errorForeground']);
  assert.deepEqual(decorationOf('dark', 'warning', file), [WARNING_BADGE, 'yamlDslEditor.dark.warningForeground']);
  assert.deepEqual(decorationOf('dark', 'info', file), ['ⓘ', 'yamlDslEditor.dark.infoForeground']);
  assert.deepEqual(decorationOf('light', 'error', file), ['✖', 'yamlDslEditor.light.errorForeground']);
  assert.deepEqual(decorationOf('dark', 'error', 'file:///repo/dev'), [undefined, 'yamlDslEditor.dark.errorForeground']);
  const staging = uriOf('file:///repo/staging/mock.yml');
  assert.equal(validatorFileDecoration(fakeVscode, 'dark', 'error', uriSets, staging), undefined);
});

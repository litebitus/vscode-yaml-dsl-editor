const test = require('node:test');
const assert = require('node:assert/strict');
const { validatorFileDecoration } = require('../lib/validator-files');
const { WARNING_BADGE, WARNING_THEME_COLOR } = require('../lib/warning-files');
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

test('a file holding a validation error takes the badge and color of the error severity, its folders the color', () => {
  const uriSets = explorerUriSets(['file:///repo/dev/mock.yml']);
  const decorationOf = (errorSeverity, uri) => {
    const decoration = validatorFileDecoration(fakeVscode, errorSeverity, uriSets, uriOf(uri));
    return [decoration.badge, decoration.color.id];
  };
  assert.deepEqual(decorationOf('error', 'file:///repo/dev/mock.yml'), ['✖', 'yamlDslEditor.errorForeground']);
  assert.deepEqual(decorationOf('warning', 'file:///repo/dev/mock.yml'), [WARNING_BADGE, WARNING_THEME_COLOR]);
  assert.deepEqual(decorationOf('info', 'file:///repo/dev/mock.yml'), ['ⓘ', 'yamlDslEditor.infoForeground']);
  assert.deepEqual(decorationOf('error', 'file:///repo/dev'), [undefined, 'yamlDslEditor.errorForeground']);
  assert.equal(validatorFileDecoration(fakeVscode, 'error', uriSets, uriOf('file:///repo/staging/mock.yml')), undefined);
});

const { explorerDecoration } = require('./explorer-folders');
const { WARNING_BADGE, WARNING_THEME_COLOR } = require('./warning-files');

const DECORATIONS_BY_SEVERITY = {
  error: { badge: '✖', themeColor: 'yamlDslEditor.errorForeground' },
  warning: { badge: WARNING_BADGE, themeColor: WARNING_THEME_COLOR },
  info: { badge: 'ⓘ', themeColor: 'yamlDslEditor.infoForeground' },
};

function validatorFileDecoration(vscode, errorSeverity, validatorUriSets, uri) {
  return explorerDecoration(vscode, { ...DECORATIONS_BY_SEVERITY[errorSeverity], uriSets: validatorUriSets, uri });
}

module.exports = { validatorFileDecoration };

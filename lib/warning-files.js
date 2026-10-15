const { explorerDecoration } = require('./explorer-folders');

const WARNING_BADGE = '⚠';
const WARNING_THEME_COLOR = 'yamlDslEditor.warningForeground';

function warningFileDecoration(vscode, warningUriSets, uri) {
  return explorerDecoration(vscode, {
    badge: WARNING_BADGE,
    themeColor: WARNING_THEME_COLOR,
    uriSets: warningUriSets,
    uri,
  });
}

module.exports = { WARNING_BADGE, WARNING_THEME_COLOR, warningFileDecoration };

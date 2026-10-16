const { explorerDecoration } = require('./explorer-folders');
const { THEME_ROLES, themeColorId } = require('./themes');

const WARNING_BADGE = '⚠';

function warningFileDecoration(vscode, theme, warningUriSets, uri) {
  return explorerDecoration(vscode, {
    badge: WARNING_BADGE,
    themeColor: themeColorId(theme, THEME_ROLES.warning),
    uriSets: warningUriSets,
    uri,
  });
}

module.exports = { WARNING_BADGE, warningFileDecoration };

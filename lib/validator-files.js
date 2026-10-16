const { explorerDecoration } = require('./explorer-folders');
const { WARNING_BADGE } = require('./warning-files');
const { THEME_ROLES, themeColorId } = require('./themes');

const DECORATIONS_BY_SEVERITY = {
  error: { badge: '✖', role: THEME_ROLES.error },
  warning: { badge: WARNING_BADGE, role: THEME_ROLES.warning },
  info: { badge: 'ⓘ', role: THEME_ROLES.info },
};

function validatorFileDecoration(vscode, theme, errorSeverity, validatorUriSets, uri) {
  const { badge, role } = DECORATIONS_BY_SEVERITY[errorSeverity];
  return explorerDecoration(vscode, { badge, themeColor: themeColorId(theme, role), uriSets: validatorUriSets, uri });
}

module.exports = { validatorFileDecoration };

const YAML_DSL_LANGUAGE = 'yaml-dsl';
const YAML_DSL_TEMPLATE_LANGUAGE = 'yaml-dsl-template';
const CLAIMED_LANGUAGES = new Set([YAML_DSL_LANGUAGE, YAML_DSL_TEMPLATE_LANGUAGE]);

/** The language a file a DSL claims opens in: a template language's own, else the DSL's. */
function languageOfDsl(dsl) {
  return dsl && dsl.template ? YAML_DSL_TEMPLATE_LANGUAGE : YAML_DSL_LANGUAGE;
}

/** Whether a language is one a claimed file opens in. */
function isClaimedLanguage(languageId) {
  return CLAIMED_LANGUAGES.has(languageId);
}

module.exports = { YAML_DSL_LANGUAGE, YAML_DSL_TEMPLATE_LANGUAGE, languageOfDsl, isClaimedLanguage };

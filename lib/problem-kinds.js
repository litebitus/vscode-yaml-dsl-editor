const PROBLEM_KINDS = {
  deprecation: 'deprecation',
  duplicateKey: 'duplicateKey',
  macroWarning: 'macroWarning',
  unfinishedKey: 'unfinishedKey',
  validationError: 'validationError',
};

const WARNING_SETTING_OF_KIND = {
  [PROBLEM_KINDS.deprecation]: 'deprecation',
  [PROBLEM_KINDS.macroWarning]: 'macro',
};

function withSchemaNote(problem, schemaNote) {
  return schemaNote ? { ...problem, schemaNote } : problem;
}

module.exports = { PROBLEM_KINDS, WARNING_SETTING_OF_KIND, withSchemaNote };

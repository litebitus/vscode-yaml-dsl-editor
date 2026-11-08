const PROBLEM_KINDS = {
  deprecation: 'deprecation',
  duplicateKey: 'duplicateKey',
  unfinishedKey: 'unfinishedKey',
  validationError: 'validationError',
};

function withSchemaNote(problem, schemaNote) {
  return schemaNote ? { ...problem, schemaNote } : problem;
}

module.exports = { PROBLEM_KINDS, withSchemaNote };

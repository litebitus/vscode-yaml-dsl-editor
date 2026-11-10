const { createValidationHost } = require('../lib/validation-host');
const { resolvedDocumentOf } = require('../lib/resolved-document');

const MOCK_SCHEMA_HASH = 'mock-schema-hash';

function resolvedDocumentProblemsOf(schema, document, { fragmentPointer = null, validator = null } = {}) {
  const host = createValidationHost();
  host.addSchema(MOCK_SCHEMA_HASH, JSON.stringify(schema), null);
  return host.problemsOf(MOCK_SCHEMA_HASH, document, { fragmentPointer, validator });
}

function validationProblemsOf(schema, value, options = {}) {
  return resolvedDocumentProblemsOf(schema, resolvedDocumentOf(value), options);
}

function quotedValuesValidator(allowQuotedValues) {
  return { merge_base_keys: [], child_values_from_parent_key: [], allow_quoted_values: allowQuotedValues };
}

function problemTextsOf(problems) {
  return problems.map(({ path, message, schemaNote }) => (schemaNote ? [path, message, schemaNote] : [path, message]));
}

module.exports = {
  resolvedDocumentProblemsOf,
  validationProblemsOf,
  quotedValuesValidator,
  problemTextsOf,
};

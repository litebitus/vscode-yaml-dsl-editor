const { createSchemaChecks } = require('./schema-checks');
const { compiledSchemaFileStore } = require('./compiled-schema-files');

const VALIDATION_MESSAGE_KINDS = {
  schema: 'schema',
  dropSchema: 'drop_schema',
  validate: 'validate',
  answer: 'answer',
  log: 'log',
};
const VALIDATION_FAILED_KEYWORD = 'validationFailed';

function validationFailedProblem(message) {
  return { path: [], message, keyword: VALIDATION_FAILED_KEYWORD };
}

function createValidationHost({ buildKey = null, reportProblem = () => {} } = {}) {
  const schemasByHash = new Map();
  const schemaChecks = createSchemaChecks(
    (schemaHash) => (schemasByHash.has(schemaHash) ? schemasByHash.get(schemaHash).root : null),
    (schemaHash) => {
      const schema = schemasByHash.get(schemaHash);
      if (!schema || !schema.compiledSchemaFile || !buildKey) return null;
      return compiledSchemaFileStore(schema.compiledSchemaFile, { schemaHash, buildKey }, reportProblem);
    },
  );

  function addSchema(schemaHash, root, compiledSchemaFile) {
    if (!schemasByHash.has(schemaHash)) schemasByHash.set(schemaHash, { root, compiledSchemaFile });
  }

  function hasSchema(schemaHash) {
    return schemasByHash.has(schemaHash);
  }

  function dropSchema(schemaHash) {
    schemasByHash.delete(schemaHash);
  }

  function problemsOf(schemaHash, value, { fragmentPointer, allowQuotedValues }) {
    try {
      return schemaChecks.documentProblems(schemaHash, value, { fragmentPointer, allowQuotedValues });
    } catch (error) {
      return [validationFailedProblem(`validation failed: ${error.message}`)];
    }
  }

  return { addSchema, hasSchema, dropSchema, problemsOf };
}

module.exports = {
  VALIDATION_MESSAGE_KINDS,
  VALIDATION_FAILED_KEYWORD,
  validationFailedProblem,
  createValidationHost,
};

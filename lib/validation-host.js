const { schemaValidation } = require('yaml-dsl-spec');
const { schemaCompileMessageOf } = require('./schema-checks');
const { withSchemaNote } = require('./problem-kinds');
const { resolvedValueOf, documentPathOf } = require('./resolved-document');
const { schemaStoreFilesOf } = require('./schema-store-files');

const VALIDATION_MESSAGE_KINDS = {
  schema: 'schema',
  dropSchema: 'drop_schema',
  schemaCapacity: 'schema_capacity',
  validate: 'validate',
  answer: 'answer',
  log: 'log',
};
const VALIDATION_FAILED_KEYWORD = 'validationFailed';
const SCHEMA_COMPILE_KEYWORD = 'schemaCompile';
const RULE_PLACE_SEPARATOR = ', at ';

function validationFailedProblem(message) {
  return { path: [], message, keyword: VALIDATION_FAILED_KEYWORD };
}

function keywordOfRule(rule) {
  if (!rule) return null;
  const placeStart = rule.indexOf(RULE_PLACE_SEPARATOR);
  return placeStart < 0 ? rule : rule.slice(0, placeStart);
}

function compilerTextOf(failureMessage, schemaName) {
  const namePrefix = `schema ${schemaName}: `;
  return failureMessage.startsWith(namePrefix) ? failureMessage.slice(namePrefix.length) : failureMessage;
}

function createValidationHost({ reportProblem = () => {} } = {}) {
  const schemasByHash = new Map();
  let storeFolderOfLoad = null;
  const schemaStore = {
    read: (key) => (storeFolderOfLoad ? schemaStoreFilesOf(storeFolderOfLoad, reportProblem).read(key) : null),
    write: (key, prepared) => {
      if (storeFolderOfLoad) schemaStoreFilesOf(storeFolderOfLoad, reportProblem).write(key, prepared);
    },
  };
  let schemaCache = new schemaValidation.SchemaCache({ store: schemaStore });

  function setSchemaCapacity(capacity) {
    schemaCache = new schemaValidation.SchemaCache({ capacity, store: schemaStore });
  }

  function addSchema(schemaHash, schemaText, schemaStoreFolder) {
    if (!schemasByHash.has(schemaHash)) {
      schemasByHash.set(schemaHash, { schemaText, schemaStoreFolder, loading: null });
    }
  }

  function hasSchema(schemaHash) {
    return schemasByHash.has(schemaHash);
  }

  function dropSchema(schemaHash) {
    schemasByHash.delete(schemaHash);
  }

  function loadingOf(schemaHash, schema) {
    if (!schema.loading) {
      storeFolderOfLoad = schema.schemaStoreFolder;
      try {
        schema.loading = { loadedSchema: schemaCache.load(schemaHash, schema.schemaText), failure: null };
      } catch (error) {
        schema.loading = { loadedSchema: null, failure: compilerTextOf(error.message, schemaHash) };
      } finally {
        storeFolderOfLoad = null;
      }
    }
    return schema.loading;
  }

  function specProblemsOf(loadedSchema, document, fragmentPointer, validator) {
    const rules = schemaValidation.ValidationRules.fromValidator(validator);
    const documentValue = resolvedValueOf(document);
    return fragmentPointer === null
      ? loadedSchema.problems(documentValue, rules)
      : loadedSchema.fragmentProblems(fragmentPointer, documentValue, rules);
  }

  function problemsOf(schemaHash, document, { fragmentPointer = null, validator = null } = {}) {
    try {
      const schema = schemasByHash.get(schemaHash);
      if (!schema) return [];
      const { loadedSchema, failure } = loadingOf(schemaHash, schema);
      if (failure !== null) {
        return [{ path: [], message: schemaCompileMessageOf(failure), keyword: SCHEMA_COMPILE_KEYWORD }];
      }
      const problemKeys = new Set();
      return specProblemsOf(loadedSchema, document, fragmentPointer, validator)
        .map(({ subject, diagnostic }) => {
          const notes = diagnostic.notes || {};
          const problem = {
            path: documentPathOf(document, subject),
            message: diagnostic.message,
            keyword: keywordOfRule(notes.rule),
          };
          return withSchemaNote(problem, notes.schema);
        })
        .filter((problem) => {
          const problemKey = JSON.stringify([problem.path, problem.message, problem.schemaNote]);
          if (problemKeys.has(problemKey)) return false;
          problemKeys.add(problemKey);
          return true;
        });
    } catch (error) {
      return [validationFailedProblem(`validation failed: ${error.message}`)];
    }
  }

  return { setSchemaCapacity, addSchema, hasSchema, dropSchema, problemsOf };
}

module.exports = {
  VALIDATION_MESSAGE_KINDS,
  VALIDATION_FAILED_KEYWORD,
  validationFailedProblem,
  createValidationHost,
};

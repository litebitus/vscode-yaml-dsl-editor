const VALIDATOR_OPTIONS = {
  allErrors: true,
  strict: false,
  unicodeRegExp: false,
  validateSchema: false,
  validateFormats: false,
  logger: false,
};
const ALTERNATIVE_KEYWORDS = new Set(['anyOf', 'oneOf']);
const SCHEMA_COMPILE_KEYWORD = 'schemaCompile';

function pathSegmentsOf(instancePath, value) {
  const segments = [];
  let node = value;
  for (const part of instancePath.split('/').slice(1)) {
    const text = part.replaceAll('~1', '/').replaceAll('~0', '~');
    const segment = Array.isArray(node) ? Number(text) : text;
    segments.push(segment);
    node = node === null || node === undefined ? undefined : node[segment];
  }
  return segments;
}

function instanceHolds(instancePath, innerPath) {
  return innerPath === instancePath || innerPath.startsWith(`${instancePath}/`);
}

function withoutAlternativeBranchErrors(errors) {
  const kept = [];
  for (const error of errors) {
    if (ALTERNATIVE_KEYWORDS.has(error.keyword)) {
      while (kept.length > 0 && instanceHolds(error.instancePath, kept[kept.length - 1].instancePath)) kept.pop();
    }
    kept.push(error);
  }
  return kept;
}

function createSchemaValidator(root, draft) {
  const ajv = new draft.ValidatorClass(VALIDATOR_OPTIONS);
  let rootValidation = null;

  function compile(schema) {
    return ajv.compile(schema);
  }

  function compiledRoot() {
    if (rootValidation) return rootValidation;
    try {
      rootValidation = { validate: ajv.compile(root), problem: null };
    } catch (error) {
      rootValidation = { validate: null, problem: `the schema cannot be compiled: ${error.message}` };
    }
    return rootValidation;
  }

  function documentFailures(value) {
    const { validate, problem } = compiledRoot();
    if (!validate) return [{ path: [], keyword: SCHEMA_COMPILE_KEYWORD, params: {}, message: problem, schemaPath: '#' }];
    if (validate(value)) return [];
    return withoutAlternativeBranchErrors(validate.errors).map((error) => ({
      path: pathSegmentsOf(error.instancePath, value),
      keyword: error.keyword,
      params: error.params,
      message: error.message,
      schemaPath: error.schemaPath,
    }));
  }

  return { compile, documentFailures };
}

module.exports = { SCHEMA_COMPILE_KEYWORD, createSchemaValidator };

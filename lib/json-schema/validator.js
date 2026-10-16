const VALIDATOR_OPTIONS = {
  allErrors: true,
  strict: false,
  unicodeRegExp: false,
  validateSchema: false,
  validateFormats: false,
  logger: false,
  verbose: true,
};
const ALTERNATIVE_KEYWORDS = new Set(['anyOf', 'oneOf']);
const PROPERTY_NAMES_KEYWORD = 'propertyNames';
const CONDITION_KEYWORD = 'if';
const SCHEMA_COMPILE_KEYWORD = 'schemaCompile';
const DEPENDENCY_KEYWORD = 'dependency';

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

function reachableSchemaObjectsOf(start, parser) {
  const reached = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || reached.has(node)) continue;
    reached.add(node);
    const reference = Array.isArray(node) ? null : parser.referenceOf(node);
    if (reference !== null) pending.push(parser.resolveReference(reference));
    pending.push(...Object.values(node));
  }
  return reached;
}

function createInnerErrorCheck(parser) {
  const reachableByBranches = new WeakMap();

  function branchesReach(branches, schemaObject) {
    if (!reachableByBranches.has(branches)) reachableByBranches.set(branches, reachableSchemaObjectsOf(branches, parser));
    return reachableByBranches.get(branches).has(schemaObject);
  }

  return function innerErrorOf(error, inner) {
    if (ALTERNATIVE_KEYWORDS.has(error.keyword)) {
      return instanceHolds(error.instancePath, inner.instancePath) && branchesReach(error.schema, inner.parentSchema);
    }
    if (error.keyword === PROPERTY_NAMES_KEYWORD) {
      return inner.instancePath === error.instancePath && inner.propertyName === error.params.propertyName;
    }
    return false;
  };
}

function withoutInnerErrors(errors, innerErrorOf) {
  const kept = [];
  for (const error of errors) {
    while (kept.length > 0 && innerErrorOf(error, kept[kept.length - 1])) kept.pop();
    kept.push(error);
  }
  return kept;
}

function valueAtPath(value, path) {
  return path.reduce((node, segment) => (node === null || node === undefined ? undefined : node[segment]), value);
}

function dependencyKeyOf(error, holder, draft) {
  const { dependencyMapKeywords, schemaMapKeywords } = draft;
  if (dependencyMapKeywords.includes(error.keyword) && typeof error.params.property === 'string') {
    return error.params.property;
  }
  const schemaSegments = error.schemaPath.split('/');
  for (let index = schemaSegments.length - 2; index >= 1; index -= 1) {
    if (!dependencyMapKeywords.includes(schemaSegments[index])) continue;
    if (schemaMapKeywords.includes(schemaSegments[index - 1])) continue;
    const key = schemaSegments[index + 1].replaceAll('~1', '/').replaceAll('~0', '~');
    const holdsKey = holder !== null && typeof holder === 'object' && Object.hasOwn(holder, key);
    return holdsKey ? key : null;
  }
  return null;
}

function withDependenciesCombined(failures, value, draft) {
  const combined = [];
  const dependenciesSeen = new Set();
  for (const failure of failures) {
    const key = dependencyKeyOf(failure, valueAtPath(value, failure.path), draft);
    if (key === null) {
      combined.push(failure);
      continue;
    }
    const dependencyId = JSON.stringify([failure.path, key]);
    if (dependenciesSeen.has(dependencyId)) continue;
    dependenciesSeen.add(dependencyId);
    combined.push({
      path: failure.path,
      keyword: DEPENDENCY_KEYWORD,
      params: { property: key },
      message: failure.message,
      schemaPath: failure.schemaPath,
    });
  }
  return combined;
}

function createSchemaValidator(root, draft, parser) {
  const ajv = new draft.ValidatorClass(VALIDATOR_OPTIONS);
  const innerErrorOf = createInnerErrorCheck(parser);
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
    const reasons = validate.errors.filter((error) => error.keyword !== CONDITION_KEYWORD);
    const failures = withoutInnerErrors(reasons, innerErrorOf).map((error) => ({
      path: pathSegmentsOf(error.instancePath, value),
      keyword: error.keyword,
      params: error.params,
      message: error.message,
      schemaPath: error.schemaPath,
    }));
    return withDependenciesCombined(failures, value, draft);
  }

  return { compile, documentFailures };
}

module.exports = { SCHEMA_COMPILE_KEYWORD, DEPENDENCY_KEYWORD, createSchemaValidator };

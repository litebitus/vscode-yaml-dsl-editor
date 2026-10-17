const { pointerSegmentsOf, schemaNodePointersOf, schemaNodeAt } = require('./schema-pointers');
const { standaloneRootSource, loadedRootValidate } = require('./standalone-root');

const VALIDATOR_OPTIONS = {
  allErrors: true,
  strict: false,
  unicodeRegExp: true,
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
const ROOT_SCHEMA_KEY = 'yaml-dsl-editor-root';
const PART_SCHEMA_KEY_PREFIX = 'yaml-dsl-editor-part-';
const ROOT_REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef']);
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);
const FRAGMENT_POINTER_KEYWORD = 'fragmentPointer';
const TYPE_KEYWORD = 'type';
const INTEGER_TEXT = /^-?(0|[1-9]\d*)$/;
const NUMBER_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const QUOTED_VALUE_READERS = {
  boolean: (text) => ({ true: true, false: false })[text],
  integer: (text) => (INTEGER_TEXT.test(text) ? Number(text) : undefined),
  number: (text) => (NUMBER_TEXT.test(text) ? Number(text) : undefined),
};
const QUOTED_VALUE_TYPES = Object.keys(QUOTED_VALUE_READERS);
const REQUIREDNESS_KEYWORDS = new Set(['required', 'dependentRequired', 'dependencies']);

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

function createRequirednessRelaxer(parser) {
  const reachableByBranch = new WeakMap();
  const reaches = (branch, schemaObject) => {
    if (branch === null || typeof branch !== 'object') return false;
    if (!reachableByBranch.has(branch)) reachableByBranch.set(branch, reachableSchemaObjectsOf(branch, parser));
    return reachableByBranch.get(branch).has(schemaObject);
  };
  return function withoutRequiredness(errors) {
    const dropped = new Set(errors.filter((error) => REQUIREDNESS_KEYWORDS.has(error.keyword)));
    for (const error of errors) {
      if (!ALTERNATIVE_KEYWORDS.has(error.keyword) || !Array.isArray(error.schema)) continue;
      const inner = errors.filter((candidate) => candidate !== error
        && instanceHolds(error.instancePath, candidate.instancePath));
      const innerByBranch = error.schema
        .map((branch) => inner.filter((candidate) => reaches(branch, candidate.parentSchema)));
      const branchPasses = (found) => found.length > 0 && found.every((candidate) => dropped.has(candidate));
      if (!innerByBranch.some(branchPasses)) continue;
      dropped.add(error);
      for (const found of innerByBranch) for (const candidate of found) dropped.add(candidate);
    }
    return errors.filter((error) => !dropped.has(error));
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

function quotedValueOf(text, expectedTypes, allowQuotedValues) {
  for (const type of [].concat(expectedTypes)) {
    if (!allowQuotedValues.includes(type)) continue;
    const value = QUOTED_VALUE_READERS[type](text);
    if (value !== undefined) return { value };
  }
  return null;
}

function withValueAt(document, path, value) {
  if (path.length === 0) return value;
  const holder = path.slice(0, -1).reduce((node, segment) => node[segment], document);
  holder[path[path.length - 1]] = value;
  return document;
}

function documentWithQuotedValuesRead(validate, value, allowQuotedValues) {
  if (allowQuotedValues.length === 0 || validate(value)) return value;
  let readDocument = structuredClone(value);
  for (;;) {
    if (validate(readDocument)) return readDocument;
    let quotedValuesRead = 0;
    for (const error of validate.errors) {
      if (error.keyword !== TYPE_KEYWORD || typeof error.data !== 'string') continue;
      const quoted = quotedValueOf(error.data, error.params.type, allowQuotedValues);
      if (!quoted) continue;
      readDocument = withValueAt(readDocument, pathSegmentsOf(error.instancePath, readDocument), quoted.value);
      quotedValuesRead += 1;
    }
    if (quotedValuesRead === 0) return readDocument;
  }
}

function isLocalReference(keyword, value) {
  return ROOT_REFERENCE_KEYWORDS.has(keyword) && typeof value === 'string' && value.startsWith('#');
}

function localReferencesOf(node, references = []) {
  if (Array.isArray(node)) {
    for (const item of node) localReferencesOf(item, references);
    return references;
  }
  if (node === null || typeof node !== 'object') return references;
  for (const [keyword, value] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(keyword)) continue;
    if (isLocalReference(keyword, value)) references.push(value);
    else localReferencesOf(value, references);
  }
  return references;
}

function withReferencesInto(node, schemaKey) {
  if (Array.isArray(node)) return node.map((item) => withReferencesInto(item, schemaKey));
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([keyword, value]) => {
    if (DATA_KEYWORDS.has(keyword)) return [keyword, value];
    return [keyword, isLocalReference(keyword, value) ? `${schemaKey}${value}` : withReferencesInto(value, schemaKey)];
  }));
}

function createSchemaValidator(root, draft, parser, compiledRootStore = null) {
  const ajv = new draft.ValidatorClass(compiledRootStore
    ? { ...VALIDATOR_OPTIONS, code: { source: true } }
    : VALIDATOR_OPTIONS);
  const innerErrorOf = createInnerErrorCheck(parser);
  const conditionChecks = new Map();
  const withoutRequiredness = createRequirednessRelaxer(parser);
  let rootValidation = null;
  let rootAdded = false;
  let pointersBySchemaNode = null;
  let partsCompiled = 0;

  function addRootOnce() {
    if (rootAdded) return;
    ajv.addSchema(root, ROOT_SCHEMA_KEY);
    rootAdded = true;
  }

  function pointerOfReference(reference) {
    if (reference === '#') return '';
    if (reference.startsWith('#/')) return decodeURIComponent(reference.slice(1));
    const anchored = parser.resolveReference(reference);
    if (anchored === null) return null;
    if (!pointersBySchemaNode) pointersBySchemaNode = schemaNodePointersOf(root);
    const pointer = pointersBySchemaNode.get(anchored);
    return pointer === undefined ? null : pointer;
  }

  function reachedPointersOf(part) {
    const pointers = new Set();
    const pending = localReferencesOf(part);
    while (pending.length > 0) {
      const pointer = pointerOfReference(pending.pop());
      if (pointer === null || pointers.has(pointer)) continue;
      const target = schemaNodeAt(root, pointer);
      if (target === undefined) continue;
      pointers.add(pointer);
      localReferencesOf(target, pending);
    }
    return pointers;
  }

  function placedAt(partialRoot, pointer) {
    const segments = pointerSegmentsOf(pointer);
    let original = root;
    let placed = partialRoot;
    for (const [index, segment] of segments.entries()) {
      const originalChild = original[segment];
      if (placed[segment] === originalChild) return;
      if (index === segments.length - 1) {
        placed[segment] = originalChild;
        return;
      }
      if (placed[segment] === undefined || placed[segment] === true) {
        placed[segment] = Array.isArray(originalChild) ? originalChild.map(() => true) : {};
      }
      original = originalChild;
      placed = placed[segment];
    }
  }

  function partialRootOf(pointers) {
    if (pointers.has('')) return root;
    const partialRoot = {};
    const byDepth = [...pointers].sort((left, right) => left.split('/').length - right.split('/').length);
    for (const pointer of byDepth) placedAt(partialRoot, pointer);
    return partialRoot;
  }

  function compileRootPart(schema) {
    const pointers = reachedPointersOf(schema);
    if (pointers.size === 0) return ajv.compile(schema);
    partsCompiled += 1;
    const partKey = `${PART_SCHEMA_KEY_PREFIX}${partsCompiled}`;
    const partSchema = withReferencesInto(schema, partKey);
    ajv.addSchema(partialRootOf(pointers), partKey);
    try {
      return ajv.compile(partSchema);
    } finally {
      ajv.removeSchema(partKey);
      ajv.removeSchema(partSchema);
    }
  }

  function savedRootValidate() {
    const source = compiledRootStore ? compiledRootStore.load() : null;
    if (source === null) return null;
    try {
      return loadedRootValidate(source, root, compiledRootStore.filename);
    } catch {
      return null;
    }
  }

  function compiledRootValidate() {
    const saved = savedRootValidate();
    if (saved) return saved;
    const validate = ajv.compile(root);
    if (compiledRootStore) compiledRootStore.save(standaloneRootSource(ajv, validate, root));
    return validate;
  }

  function compiledRoot() {
    if (rootValidation) return rootValidation;
    try {
      rootValidation = { validate: compiledRootValidate(), problem: null };
    } catch (error) {
      rootValidation = { validate: null, problem: `the schema cannot be compiled: ${error.message}` };
    }
    return rootValidation;
  }

  function validateAt(pointer) {
    if (!compiledRoot().validate) return null;
    if (pointer === '') return compiledRoot().validate;
    addRootOnce();
    try {
      return ajv.getSchema(`${ROOT_SCHEMA_KEY}#${pointer}`) || null;
    } catch {
      return null;
    }
  }

  function documentFailures(value, { fragmentPointer = null, allowQuotedValues = [] } = {}) {
    const { validate: rootValidate, problem } = compiledRoot();
    if (!rootValidate) {
      return [{ path: [], keyword: SCHEMA_COMPILE_KEYWORD, params: {}, message: problem, schemaPath: '#' }];
    }
    const validate = fragmentPointer === null ? rootValidate : validateAt(fragmentPointer);
    if (!validate) {
      const message = `the schema has no node at \`#${fragmentPointer}\``;
      return [{ path: [], keyword: FRAGMENT_POINTER_KEYWORD, params: {}, message, schemaPath: '#' }];
    }
    const readDocument = documentWithQuotedValuesRead(validate, value, allowQuotedValues);
    if (validate(readDocument)) return [];
    const errors = validate.errors.filter((error) => error.keyword !== CONDITION_KEYWORD);
    const reasons = fragmentPointer === null ? errors : withoutRequiredness(errors);
    const failures = withoutInnerErrors(reasons, innerErrorOf).map((error) => ({
      path: pathSegmentsOf(error.instancePath, readDocument),
      keyword: error.keyword,
      params: error.params,
      message: error.message,
      schemaPath: error.schemaPath,
    }));
    return withDependenciesCombined(failures, readDocument, draft);
  }

  function conditionCheckOf(condition) {
    try {
      return compileRootPart(condition);
    } catch {
      return null;
    }
  }

  function conditionHolds(condition, instance) {
    if (typeof condition === 'boolean') return condition;
    if (!conditionChecks.has(condition)) conditionChecks.set(condition, conditionCheckOf(condition));
    const check = conditionChecks.get(condition);
    return check ? check(instance) : null;
  }

  return { compileRootPart, documentFailures, conditionHolds };
}

module.exports = {
  SCHEMA_COMPILE_KEYWORD,
  FRAGMENT_POINTER_KEYWORD,
  DEPENDENCY_KEYWORD,
  QUOTED_VALUE_TYPES,
  createSchemaValidator,
};

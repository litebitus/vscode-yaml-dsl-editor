const crypto = require('crypto');
const { schemaParserFor, schemaValidatorFor, schemaRendererFor } = require('./json-schema');
const { SCHEMA_COMPILE_KEYWORD, FRAGMENT_POINTER_KEYWORD, DEPENDENCY_KEYWORD } = require('./json-schema/validator');
const { codeSpan, fencedCodeBlock } = require('./json-schema/render');
const { withSchemaNote } = require('./problem-kinds');

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'examples', '$comment']);
const APPLICATOR_COMBINING_KEYWORDS = ['allOf', 'anyOf', 'not', 'oneOf'];
const CONDITION_KEYWORDS = new Set(['if', 'not']);
const FORM_SELECTING_KEYWORDS = new Set(['anyOf', 'oneOf']);
const BRANCH_KEYWORDS = ['if', 'then', 'else'];

const REQUIREDNESS_MARKERS = {
  required: '[required]',
  conditionallyRequired: '[~required]',
  optional: '[optional]',
};
const REQUIREDNESS_MARKER_KEYWORD = 'requirednessMarker';

const NODE_STATES = {
  noSchema: 'no_schema',
  notAllowed: 'not_allowed',
  open: 'open',
  constrained: 'constrained',
};

const EMPTY_MAP_OPT_OUT = {};
const NOT_ALLOWED_MESSAGE = 'the schema does not allow it';
const NOT_FAILURE_MESSAGE = 'matches a form that is not allowed';
const SCHEMA_COMPILE_MESSAGE = 'the schema cannot be compiled';
const FAILURE_KINDS = { message: 'message', alternatives: 'alternatives' };

function schemaCompileMessageOf(compilerText) {
  return `${SCHEMA_COMPILE_MESSAGE}\n\n${fencedCodeBlock(compilerText, 'text')}`;
}

function messageFailure(text, schemaNote = null) {
  return withSchemaNote({ kind: FAILURE_KINDS.message, text, alternatives: [] }, schemaNote);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function plainJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(plainJsonText).join(',')}]`;
  if (value && typeof value === 'object') {
    const members = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${plainJsonText(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

function requirednessMarkerOf(node) {
  if (!node || typeof node !== 'object' || typeof node.description !== 'string') return null;
  const description = node.description.trimStart();
  return Object.values(REQUIREDNESS_MARKERS).find((marker) => description.startsWith(marker)) || null;
}

function writtenDescriptionOf(node) {
  return typeof node.description === 'string' && node.description.trim() ? node.description : null;
}

function isSchemaMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function markersOfFields(properties) {
  const markers = new Map();
  for (const [key, field] of Object.entries(properties)) {
    const marker = requirednessMarkerOf(field);
    if (marker) markers.set(key, marker);
  }
  return markers;
}

function keywordSetsOf(draft) {
  return {
    sameInstanceSchema: new Set(draft.sameInstanceSchemaKeywords),
    sameInstanceList: new Set(draft.sameInstanceListKeywords),
    childSchema: new Set(draft.childSchemaKeywords),
    schemaMap: new Set(draft.schemaMapKeywords),
    combining: new Set([...draft.referenceKeywords, ...APPLICATOR_COMBINING_KEYWORDS, ...BRANCH_KEYWORDS]),
    reference: new Set(draft.referenceKeywords),
  };
}

function markedSchema(node, markersInScope, keywordSets) {
  if (!isSchemaMap(node)) return node;
  const ownsFields = isSchemaMap(node.properties);
  const markers = ownsFields ? markersOfFields(node.properties) : markersInScope;
  const marked = {};
  const markedChild = (child) => markedSchema(child, null, keywordSets);
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'required') continue;
    if (CONDITION_KEYWORDS.has(keyword)) marked[keyword] = value;
    else if (keywordSets.sameInstanceSchema.has(keyword)) marked[keyword] = markedSchema(value, markers, keywordSets);
    else if (keywordSets.sameInstanceList.has(keyword) && Array.isArray(value)) {
      const branchMarkers = FORM_SELECTING_KEYWORDS.has(keyword) ? null : markers;
      marked[keyword] = value.map((branch) => markedSchema(branch, branchMarkers, keywordSets));
    } else if (keywordSets.childSchema.has(keyword)) {
      marked[keyword] = Array.isArray(value) ? value.map(markedChild) : markedChild(value);
    } else if (keywordSets.schemaMap.has(keyword) && isSchemaMap(value)) {
      marked[keyword] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, markedChild(sub)]));
    } else {
      marked[keyword] = value;
    }
  }
  const listed = Array.isArray(node.required) ? node.required : [];
  const required = listed.filter((key) => !markers || !markers.has(key));
  if (ownsFields) {
    for (const [key, marker] of markers) if (marker === REQUIREDNESS_MARKERS.required) required.push(key);
  }
  if (required.length > 0) marked.required = required;
  const ownMarker = requirednessMarkerOf(node);
  if (ownMarker) marked[REQUIREDNESS_MARKER_KEYWORD] = ownMarker;
  return marked;
}

function sameNodes(left, right) {
  if (left.state !== right.state) return false;
  if (left.state !== NODE_STATES.constrained) return true;
  return left.node === right.node || left.fingerprint() === right.fingerprint();
}

function nodeCheckRecord(fields) {
  const record = { ...fields, sameNodeAs: (other) => sameNodes(record, other) };
  return record;
}

function unconstrainedNodeCheck(state, optOutFailures = () => []) {
  return nodeCheckRecord({
    state,
    node: null,
    fingerprint: () => state,
    optOutFailures,
    conditionallyRequiredFields: () => [],
    defaultValue: () => null,
  });
}

function createSchemaChecks(schemaObjectFor, compiledRootStoreOf = () => null) {
  const checksBySchemaObject = new WeakMap();

  function memoFor(root, schemaHash) {
    if (!checksBySchemaObject.has(root)) {
      const parser = schemaParserFor(root);
      if (!parser) return null;
      const keywordSets = keywordSetsOf(parser.draft);
      const markedRoot = markedSchema(root, null, keywordSets);
      checksBySchemaObject.set(root, {
        validator: schemaValidatorFor(markedRoot, compiledRootStoreOf(schemaHash)),
        keywordSets,
        markedRoot,
        markedParser: schemaParserFor(markedRoot),
        nodes: new WeakMap(),
        ownKeywordFailures: new WeakMap(),
        refFingerprints: new Map(),
        refsInProgress: new Set(),
        cyclesCut: 0,
      });
    }
    return checksBySchemaObject.get(root);
  }

  function schemaText(root, node, memo) {
    if (Array.isArray(node)) return `[${node.map((item) => schemaText(root, item, memo)).join(',')}]`;
    if (!node || typeof node !== 'object') return JSON.stringify(node);
    const members = Object.keys(node)
      .filter((keyword) => !ANNOTATION_KEYWORDS.has(keyword))
      .sort()
      .map((keyword) => `${JSON.stringify(keyword)}:${keywordText(root, keyword, node[keyword], memo)}`);
    return `{${members.join(',')}}`;
  }

  function keywordText(root, keyword, value, memo) {
    const { keywordSets } = memo;
    if (keywordSets.reference.has(keyword)) return JSON.stringify(refFingerprint(root, value, memo));
    if (keywordSets.sameInstanceSchema.has(keyword)
      || keywordSets.sameInstanceList.has(keyword)
      || keywordSets.childSchema.has(keyword)) {
      return schemaText(root, value, memo);
    }
    if (keywordSets.schemaMap.has(keyword) && isSchemaMap(value)) {
      const members = Object.keys(value)
        .sort()
        .map((name) => `${JSON.stringify(name)}:${schemaText(root, value[name], memo)}`);
      return `{${members.join(',')}}`;
    }
    return plainJsonText(value);
  }

  function refFingerprint(root, ref, memo) {
    if (memo.refFingerprints.has(ref)) return memo.refFingerprints.get(ref);
    if (memo.refsInProgress.has(ref) || typeof ref !== 'string') {
      memo.cyclesCut += 1;
      return `cycle ${ref}`;
    }
    const cyclesBefore = memo.cyclesCut;
    memo.refsInProgress.add(ref);
    const fingerprint = sha256Text(schemaText(root, memo.markedParser.resolveReference(ref), memo));
    memo.refsInProgress.delete(ref);
    if (memo.cyclesCut === cyclesBefore) memo.refFingerprints.set(ref, fingerprint);
    return fingerprint;
  }

  function perOptOutValue(compute) {
    const failuresByValue = new Map();
    return (optOutValue = EMPTY_MAP_OPT_OUT) => {
      const valueKey = plainJsonText(optOutValue);
      if (!failuresByValue.has(valueKey)) failuresByValue.set(valueKey, compute(optOutValue));
      return failuresByValue.get(valueKey);
    };
  }

  function lazily(compute) {
    let value = null;
    return () => {
      if (value === null) value = compute();
      return value;
    };
  }

  function nodeCheck(schemaHash, blockPath) {
    const root = schemaHash ? schemaObjectFor(schemaHash) : null;
    const memo = root ? memoFor(root, schemaHash) : null;
    if (!memo) return unconstrainedNodeCheck(NODE_STATES.noSchema);
    const { markedParser } = memo;
    const node = markedParser.nodeAt(blockPath);
    if (node === null) {
      return unconstrainedNodeCheck(NODE_STATES.notAllowed, () => [messageFailure(NOT_ALLOWED_MESSAGE)]);
    }
    if (node === true) return unconstrainedNodeCheck(NODE_STATES.open);
    const nodeChecks = nodeChecksOf(memo, node);
    return nodeCheckRecord({
      state: nodeChecks.state,
      node,
      fingerprint: nodeChecks.fingerprint,
      optOutFailures: nodeChecks.optOutFailures,
      conditionallyRequiredFields: () => nodeChecks.conditionallyRequiredKeys()
        .map((key) => [...blockPath, key].join('.')),
      defaultValue: () => markedParser.defaultValueOf(node),
    });
  }

  function nodeChecksOf(memo, node) {
    if (memo.nodes.has(node)) return memo.nodes.get(node);
    const { markedRoot, markedParser } = memo;
    const open = isSchemaMap(node) && Object.keys(node).every((keyword) => ANNOTATION_KEYWORDS.has(keyword));
    const nodeChecks = {
      fingerprint: lazily(() => (open ? NODE_STATES.open : sha256Text(schemaText(markedRoot, node, memo)))),
      state: open ? NODE_STATES.open : NODE_STATES.constrained,
      optOutFailures: perOptOutValue((optOutValue) => (
        open ? [] : failuresOf(memo, node, null, new Set(), optOutValue)
      )),
      conditionallyRequiredKeys: lazily(() => Object.entries(markedParser.fieldsOf(node))
        .filter(([, field]) => isSchemaMap(field)
          && field[REQUIREDNESS_MARKER_KEYWORD] === REQUIREDNESS_MARKERS.conditionallyRequired)
        .map(([key]) => key)),
    };
    memo.nodes.set(node, nodeChecks);
    return nodeChecks;
  }

  function ownKeywordFailures(memo, node, optOutValue) {
    if (!memo.ownKeywordFailures.has(node)) memo.ownKeywordFailures.set(node, new Map());
    const failuresByValue = memo.ownKeywordFailures.get(node);
    const valueKey = plainJsonText(optOutValue);
    if (failuresByValue.has(valueKey)) return failuresByValue.get(valueKey);
    const ownKeywords = Object.fromEntries(Object.entries(node)
      .filter(([keyword]) => !memo.keywordSets.combining.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)));
    let failures = [];
    if (Object.keys(ownKeywords).length > 0) {
      try {
        const validate = memo.validator.compileRootPart(ownKeywords);
        failures = validate(optOutValue) ? [] : validate.errors.map((error) => messageFailure(error.message));
      } catch (error) {
        failures = [messageFailure(schemaCompileMessageOf(error.message))];
      }
    }
    failuresByValue.set(valueKey, failures);
    return failures;
  }

  function failuresOf(memo, node, describedAs, refsFollowed, optOutValue) {
    if (node === false) return [messageFailure(NOT_ALLOWED_MESSAGE)];
    if (!isSchemaMap(node)) return [];
    const description = writtenDescriptionOf(node) || describedAs;
    const failures = [...ownKeywordFailures(memo, node, optOutValue)];
    const reference = memo.markedParser.referenceOf(node);
    if (reference !== null && !refsFollowed.has(reference)) {
      const target = memo.markedParser.resolveReference(reference);
      const followed = new Set([...refsFollowed, reference]);
      failures.push(...failuresOf(memo, target, description, followed, optOutValue));
    }
    for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
      failures.push(...failuresOf(memo, part, description, refsFollowed, optOutValue));
    }
    if (node.not !== undefined && failuresOf(memo, node.not, null, refsFollowed, optOutValue).length === 0) {
      failures.push(messageFailure(NOT_FAILURE_MESSAGE, description));
    }
    if (node.if !== undefined) {
      const conditionHolds = failuresOf(memo, node.if, null, refsFollowed, optOutValue).length === 0;
      const branch = conditionHolds ? node.then : node.else;
      if (branch !== undefined) failures.push(...failuresOf(memo, branch, description, refsFollowed, optOutValue));
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      if (!Array.isArray(node[keyword])) continue;
      const alternatives = node[keyword]
        .map((alternative) => failuresOf(memo, alternative, null, refsFollowed, optOutValue));
      const passing = alternatives.filter((alternative) => alternative.length === 0).length;
      if (passing === 0) failures.push({ kind: FAILURE_KINDS.alternatives, text: null, alternatives });
      else if (keyword === 'oneOf' && passing > 1) {
        failures.push(messageFailure(`must match exactly one alternative, matches ${passing}`));
      }
    }
    const seen = new Set();
    return failures.filter((failure) => {
      const key = JSON.stringify(failure);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function documentProblems(schemaHash, value, { fragmentPointer = null, allowQuotedValues = [] } = {}) {
    const root = schemaHash ? schemaObjectFor(schemaHash) : null;
    const memo = root ? memoFor(root, schemaHash) : null;
    if (!memo) return [];
    const parser = fragmentPointer === null ? memo.markedParser : memo.markedParser.startingAt(fragmentPointer);
    const problemKeys = new Set();
    return memo.validator.documentFailures(value, { fragmentPointer, allowQuotedValues })
      .map((failure) => ({ ...documentProblemOf(parser || memo.markedParser, failure), keyword: failure.keyword }))
      .filter((problem) => {
        const problemKey = JSON.stringify([problem.path, problem.message, problem.schemaNote]);
        if (problemKeys.has(problemKey)) return false;
        problemKeys.add(problemKey);
        return true;
      });
  }

  return { nodeCheck, documentProblems };
}

function jsonCodeSpan(value) {
  return codeSpan(JSON.stringify(value));
}

function fieldNameOf(path) {
  if (path.length === 0) return 'the document';
  let keyIndex = path.length - 1;
  while (keyIndex >= 0 && typeof path[keyIndex] === 'number') keyIndex -= 1;
  const itemIndexes = path.slice(keyIndex + 1).map((index) => `[${index}]`).join('');
  return codeSpan(`${keyIndex >= 0 ? path[keyIndex] : ''}${itemIndexes}`);
}

const DEFINITION_POINTER = /^#\/(?:\$defs|definitions)\/[^/]+$/;

function alternativesDefinitionOf(parser, path, keyword) {
  let node = parser.nodeAt(path);
  let lastReference = null;
  const referencesFollowed = new Set();
  while (isSchemaMap(node) && !Array.isArray(node[keyword])) {
    const reference = parser.referenceOf(node);
    if (reference === null || referencesFollowed.has(reference)) return null;
    referencesFollowed.add(reference);
    lastReference = reference;
    node = parser.resolveReference(reference);
  }
  const heldByDefinition = lastReference !== null && DEFINITION_POINTER.test(lastReference);
  return heldByDefinition && isSchemaMap(node) ? node : null;
}

function alternativesDefinitionDescriptionOf(parser, path, keyword) {
  const definition = alternativesDefinitionOf(parser, path, keyword);
  return definition ? writtenDescriptionOf(definition) : null;
}

const LIMIT_COUNT_NOUNS = {
  minLength: 'characters',
  maxLength: 'characters',
  minItems: 'items',
  maxItems: 'items',
  minProperties: 'properties',
  maxProperties: 'properties',
};
const BOUND_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']);
const ITEMS_LIMIT_KEYWORDS = new Set(['items', 'additionalItems', 'unevaluatedItems']);
const FALSE_SCHEMA_KEYWORD = 'false schema';

function limitMessageOf(keyword, params) {
  if (BOUND_KEYWORDS.has(keyword)) return `must be ${params.comparison} ${jsonCodeSpan(params.limit)}`;
  if (keyword === 'multipleOf') return `must be multiple of ${jsonCodeSpan(params.multipleOf)}`;
  if (LIMIT_COUNT_NOUNS[keyword]) {
    const comparison = keyword.startsWith('min') ? 'fewer' : 'more';
    return `must NOT have ${comparison} than ${jsonCodeSpan(params.limit)} ${LIMIT_COUNT_NOUNS[keyword]}`;
  }
  if (ITEMS_LIMIT_KEYWORDS.has(keyword)) return `must NOT have more than ${jsonCodeSpan(params.limit)} items`;
  if (keyword === 'contains') {
    const most = params.maxContains === undefined ? '' : ` and no more than ${jsonCodeSpan(params.maxContains)}`;
    return `must contain at least ${jsonCodeSpan(params.minContains)}${most} valid item(s)`;
  }
  return null;
}

function valueMessageOf(failure) {
  const { keyword, params } = failure;
  if (keyword === 'const') return `must be ${jsonCodeSpan(params.allowedValue)}`;
  if (keyword === 'enum') return `must be one of ${params.allowedValues.map(jsonCodeSpan).join(', ')}`;
  if (keyword === 'type') {
    const types = Array.isArray(params.type) ? params.type : String(params.type).split(',');
    return `must be ${types.map(codeSpan).join(' or ')}`;
  }
  if (keyword === 'pattern') return `must match pattern ${codeSpan(params.pattern)}`;
  if (keyword === 'uniqueItems') {
    const [later, earlier] = failure.duplicateItems;
    return `must NOT have duplicate items (items ## ${later} and ${earlier} are identical)`;
  }
  if (keyword === FALSE_SCHEMA_KEYWORD) return 'boolean schema is false';
  return limitMessageOf(keyword, params);
}

function documentProblemOf(parser, failure) {
  const { path, keyword, params } = failure;
  const fieldName = fieldNameOf(path);
  if (keyword === SCHEMA_COMPILE_KEYWORD) return { path, message: schemaCompileMessageOf(failure.message) };
  if (keyword === FRAGMENT_POINTER_KEYWORD) return { path, message: failure.message };
  if (keyword === 'required') {
    const field = params.missingProperty;
    return { path, requiredField: field, message: `${codeSpan(field)} is required` };
  }
  if (keyword === 'additionalProperties' || keyword === 'unevaluatedProperties') {
    const key = params.additionalProperty ?? params.unevaluatedProperty;
    return { path: [...path, key], message: `${codeSpan(key)} is not a field of ${fieldName}` };
  }
  if (keyword === 'propertyNames') {
    const key = params.propertyName;
    return { path: [...path, key], message: `${codeSpan(key)} is not a valid key of ${fieldName}` };
  }
  if (keyword === DEPENDENCY_KEYWORD) {
    const key = params.property;
    const holder = parser.nodeAt(path);
    const renderer = schemaRendererFor(parser.root);
    const needs = holder && renderer ? renderer.dependencyTextOf(holder, key) : null;
    return { path: [...path, key], message: needs || `${codeSpan(key)} ${failure.message}` };
  }
  if (keyword === 'anyOf' || keyword === 'oneOf') {
    if (Array.isArray(params.passingSchemas)) {
      return { path, message: `${fieldName} matches more than one of its allowed forms` };
    }
    const message = `${fieldName} matches none of its allowed forms`;
    const { requirementSetsToPass } = failure;
    const problem = requirementSetsToPass ? { path, message, requirementSetsToPass } : { path, message };
    return withSchemaNote(problem, alternativesDefinitionDescriptionOf(parser, path, keyword));
  }
  if (keyword === 'not') {
    const ruledOutDescription = failure.notSchemaDescription
      ? writtenDescriptionOf({ description: failure.notSchemaDescription })
      : null;
    return withSchemaNote({ path, message: `${fieldName} ${NOT_FAILURE_MESSAGE}` }, ruledOutDescription);
  }
  const valueMessage = valueMessageOf(failure);
  if (valueMessage) return { path, message: `${fieldName} ${valueMessage}` };
  return { path, message: `${fieldName} breaks ${codeSpan(keyword)}` };
}

module.exports = {
  FAILURE_KINDS,
  NODE_STATES,
  REQUIREDNESS_MARKERS,
  requirednessMarkerOf,
  writtenDescriptionOf,
  createSchemaChecks,
};

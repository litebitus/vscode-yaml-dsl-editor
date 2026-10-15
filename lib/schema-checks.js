const crypto = require('crypto');
const { schemaParserFor, schemaValidatorFor } = require('./json-schema');
const { SCHEMA_COMPILE_KEYWORD } = require('./json-schema/validator');

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'examples', '$comment']);
const APPLICATOR_COMBINING_KEYWORDS = ['allOf', 'anyOf', 'not', 'oneOf'];
const CONDITION_KEYWORDS = new Set(['if', 'not']);

const REQUIREMENT_MARKERS = {
  required: '[required]',
  conditionallyRequired: '[~required]',
  optional: '[optional]',
};
const REQUIREMENT_MARKER_KEYWORD = 'requirementMarker';

const NODE_STATES = {
  noSchema: 'no_schema',
  notAllowed: 'not_allowed',
  open: 'open',
  constrained: 'constrained',
};

const EMPTY_MAP_OPT_OUT = {};
const DEFINITION_POINTER = /^#\/(definitions|\$defs)\/[^/]+$/;
const NOT_ALLOWED_MESSAGE = 'the schema does not allow it';
const FAILURE_KINDS = { message: 'message', alternatives: 'alternatives' };

function messageFailure(text) {
  return { kind: FAILURE_KINDS.message, text, alternatives: [] };
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

function requirementMarkerOf(node) {
  if (!node || typeof node !== 'object' || typeof node.description !== 'string') return null;
  const description = node.description.trimStart();
  return Object.values(REQUIREMENT_MARKERS).find((marker) => description.startsWith(marker)) || null;
}

function descriptionTextOf(node) {
  if (typeof node.description !== 'string') return null;
  const marker = requirementMarkerOf(node);
  const text = marker ? node.description.trimStart().slice(marker.length) : node.description;
  return text.trim() || null;
}

function isSchemaMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function markersOfFields(properties) {
  const markers = new Map();
  for (const [key, field] of Object.entries(properties)) {
    const marker = requirementMarkerOf(field);
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
    combining: new Set([...draft.referenceKeywords, ...APPLICATOR_COMBINING_KEYWORDS]),
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
      marked[keyword] = value.map((branch) => markedSchema(branch, markers, keywordSets));
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
    for (const [key, marker] of markers) if (marker === REQUIREMENT_MARKERS.required) required.push(key);
  }
  if (required.length > 0) marked.required = required;
  const ownMarker = requirementMarkerOf(node);
  if (ownMarker) marked[REQUIREMENT_MARKER_KEYWORD] = ownMarker;
  return marked;
}

function createSchemaChecks(schemaObjectFor) {
  const checksBySchemaObject = new WeakMap();

  function memoFor(root) {
    if (!checksBySchemaObject.has(root)) {
      const parser = schemaParserFor(root);
      if (!parser) return null;
      const keywordSets = keywordSetsOf(parser.draft);
      const markedRoot = markedSchema(root, null, keywordSets);
      checksBySchemaObject.set(root, {
        validator: schemaValidatorFor(markedRoot),
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
    if (!root) {
      return {
        fingerprint: NODE_STATES.noSchema,
        state: NODE_STATES.noSchema,
        optOutFailures: () => [],
        conditionallyRequiredFields: () => [],
        defaultValue: () => null,
      };
    }
    const memo = memoFor(root);
    if (!memo) {
      return {
        fingerprint: NODE_STATES.noSchema,
        state: NODE_STATES.noSchema,
        optOutFailures: () => [],
        conditionallyRequiredFields: () => [],
        defaultValue: () => null,
      };
    }
    const { markedParser } = memo;
    const node = markedParser.nodeAt(blockPath);
    if (node === null) {
      return {
        fingerprint: NODE_STATES.notAllowed,
        state: NODE_STATES.notAllowed,
        optOutFailures: () => [messageFailure(NOT_ALLOWED_MESSAGE)],
        conditionallyRequiredFields: () => [],
        defaultValue: () => null,
      };
    }
    if (node === true) {
      return {
        fingerprint: NODE_STATES.open,
        state: NODE_STATES.open,
        optOutFailures: () => [],
        conditionallyRequiredFields: () => [],
        defaultValue: () => null,
      };
    }
    const nodeChecks = nodeChecksOf(memo, node);
    return {
      fingerprint: nodeChecks.fingerprint,
      state: nodeChecks.state,
      optOutFailures: nodeChecks.optOutFailures,
      conditionallyRequiredFields: () => nodeChecks.conditionallyRequiredKeys()
        .map((key) => [...blockPath, key].join('.')),
      defaultValue: () => markedParser.defaultValueOf(node),
    };
  }

  function nodeChecksOf(memo, node) {
    if (memo.nodes.has(node)) return memo.nodes.get(node);
    const { markedRoot, markedParser } = memo;
    const nodeText = schemaText(markedRoot, node, memo);
    const open = nodeText === '{}';
    const nodeChecks = {
      fingerprint: open ? NODE_STATES.open : sha256Text(nodeText),
      state: open ? NODE_STATES.open : NODE_STATES.constrained,
      optOutFailures: perOptOutValue((optOutValue) => (
        open ? [] : failuresOf(memo, node, null, new Set(), optOutValue)
      )),
      conditionallyRequiredKeys: lazily(() => Object.entries(markedParser.fieldsOf(node))
        .filter(([, field]) => isSchemaMap(field)
          && field[REQUIREMENT_MARKER_KEYWORD] === REQUIREMENT_MARKERS.conditionallyRequired)
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
      const root = memo.markedRoot;
      const definitionKeywords = ['definitions', '$defs'].filter((keyword) => root[keyword] !== undefined);
      try {
        const validate = memo.validator.compile({
          ...Object.fromEntries(definitionKeywords.map((keyword) => [keyword, root[keyword]])),
          ...ownKeywords,
        });
        failures = validate(optOutValue) ? [] : validate.errors.map((error) => messageFailure(error.message));
      } catch (error) {
        failures = [messageFailure(`the schema cannot be compiled: ${error.message}`)];
      }
    }
    failuresByValue.set(valueKey, failures);
    return failures;
  }

  function failuresOf(memo, node, describedAs, refsFollowed, optOutValue) {
    if (node === false) return [messageFailure(NOT_ALLOWED_MESSAGE)];
    if (!isSchemaMap(node)) return [];
    const description = descriptionTextOf(node) || describedAs;
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
      failures.push(messageFailure(description || 'must NOT be valid'));
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

  function documentProblems(schemaHash, value) {
    const root = schemaHash ? schemaObjectFor(schemaHash) : null;
    const memo = root ? memoFor(root) : null;
    if (!memo) return [];
    const problemKeys = new Set();
    return memo.validator.documentFailures(value)
      .map((failure) => ({ ...documentProblemOf(memo.markedParser, failure), keyword: failure.keyword }))
      .filter((problem) => {
        const problemKey = JSON.stringify([problem.path, problem.message]);
        if (problemKeys.has(problemKey)) return false;
        problemKeys.add(problemKey);
        return true;
      });
  }

  return { nodeCheck, documentProblems };
}

function codeSpan(text) {
  return `\`${text}\``;
}

function fieldNameOf(path) {
  if (path.length === 0) return 'the document';
  let keyIndex = path.length - 1;
  while (keyIndex >= 0 && typeof path[keyIndex] === 'number') keyIndex -= 1;
  const itemIndexes = path.slice(keyIndex + 1).map((index) => `[${index}]`).join('');
  return codeSpan(`${keyIndex >= 0 ? path[keyIndex] : ''}${itemIndexes}`);
}

function valueFormDescriptionOf(parser, schemaPath) {
  const formPointer = schemaPath.slice(0, schemaPath.lastIndexOf('/'));
  if (!DEFINITION_POINTER.test(formPointer)) return null;
  const form = parser.resolveReference(formPointer);
  const description = isSchemaMap(form) ? descriptionTextOf(form) : null;
  if (!description) return null;
  const firstSentence = description.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  if (/^[A-Z]{2,}\b/.test(firstSentence)) return firstSentence;
  return firstSentence[0].toLowerCase() + firstSentence.slice(1);
}

function documentProblemOf(parser, failure) {
  const { path, keyword, params } = failure;
  const fieldName = fieldNameOf(path);
  if (keyword === SCHEMA_COMPILE_KEYWORD) return { path, message: failure.message };
  if (keyword === 'required') return { path, message: `${codeSpan(params.missingProperty)} is required` };
  if (keyword === 'additionalProperties' || keyword === 'unevaluatedProperties') {
    const key = params.additionalProperty ?? params.unevaluatedProperty;
    return { path: [...path, key], message: `${codeSpan(key)} is not a field of ${fieldName}` };
  }
  if (keyword === 'propertyNames') {
    const key = params.propertyName;
    return { path: [...path, key], message: `${codeSpan(key)} is not a valid key of ${fieldName}` };
  }
  if (keyword === 'anyOf' || keyword === 'oneOf') {
    if (Array.isArray(params.passingSchemas)) {
      return { path, message: `${fieldName} matches more than one of its allowed forms` };
    }
    const described = valueFormDescriptionOf(parser, failure.schemaPath);
    const message = described
      ? `${fieldName} must be ${described}`
      : `${fieldName} matches none of its allowed forms`;
    return { path, message };
  }
  if (keyword === 'enum') {
    const allowed = params.allowedValues.map((allowedValue) => codeSpan(JSON.stringify(allowedValue))).join(', ');
    return { path, message: `${fieldName} must be one of ${allowed}` };
  }
  if (keyword === 'type') {
    const types = Array.isArray(params.type) ? params.type : String(params.type).split(',');
    return { path, message: `${fieldName} must be ${types.join(' or ')}` };
  }
  return { path, message: `${fieldName} ${failure.message}` };
}

module.exports = {
  FAILURE_KINDS,
  NODE_STATES,
  REQUIREMENT_MARKERS,
  requirementMarkerOf,
  descriptionTextOf,
  createSchemaChecks,
};

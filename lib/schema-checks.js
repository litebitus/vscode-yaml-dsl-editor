const crypto = require('crypto');
const Ajv = require('ajv');
const { resolvePointer, schemaNodeAt, schemaNodeFields } = require('./schema');

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'examples', '$comment']);
const SAME_INSTANCE_SCHEMA_KEYWORDS = new Set(['else', 'if', 'not', 'then']);
const SAME_INSTANCE_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf']);
const CHILD_SCHEMA_KEYWORDS = new Set(['additionalItems', 'additionalProperties', 'contains', 'items', 'propertyNames']);
const SCHEMA_MAP_KEYWORDS = new Set(['definitions', '$defs', 'dependencies', 'patternProperties', 'properties']);

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
const COMBINING_KEYWORDS = new Set(['$ref', 'allOf', 'anyOf', 'not', 'oneOf']);
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

function markedSchema(node, markersInScope) {
  if (!isSchemaMap(node)) return node;
  const ownsFields = isSchemaMap(node.properties);
  const markers = ownsFields ? markersOfFields(node.properties) : markersInScope;
  const marked = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'required') continue;
    if (SAME_INSTANCE_SCHEMA_KEYWORDS.has(keyword)) marked[keyword] = markedSchema(value, markers);
    else if (SAME_INSTANCE_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
      marked[keyword] = value.map((branch) => markedSchema(branch, markers));
    } else if (CHILD_SCHEMA_KEYWORDS.has(keyword)) {
      marked[keyword] = Array.isArray(value) ? value.map((item) => markedSchema(item, null)) : markedSchema(value, null);
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isSchemaMap(value)) {
      marked[keyword] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, markedSchema(sub, null)]));
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
      checksBySchemaObject.set(root, {
        ajv: new Ajv({ allErrors: true, strict: false, unicodeRegExp: false, validateSchema: false }),
        markedRoot: markedSchema(root, null),
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
    if (keyword === '$ref') return JSON.stringify(refFingerprint(root, value, memo));
    if (SAME_INSTANCE_SCHEMA_KEYWORDS.has(keyword)
      || SAME_INSTANCE_LIST_KEYWORDS.has(keyword)
      || CHILD_SCHEMA_KEYWORDS.has(keyword)) {
      return schemaText(root, value, memo);
    }
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isSchemaMap(value)) {
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
    const fingerprint = sha256Text(schemaText(root, resolvePointer(root, ref), memo));
    memo.refsInProgress.delete(ref);
    if (memo.cyclesCut === cyclesBefore) memo.refFingerprints.set(ref, fingerprint);
    return fingerprint;
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
      };
    }
    const memo = memoFor(root);
    const { markedRoot } = memo;
    const node = schemaNodeAt(markedRoot, blockPath);
    if (node === null) {
      return {
        fingerprint: NODE_STATES.notAllowed,
        state: NODE_STATES.notAllowed,
        optOutFailures: () => [messageFailure(NOT_ALLOWED_MESSAGE)],
        conditionallyRequiredFields: () => [],
      };
    }
    if (node === true) {
      return {
        fingerprint: NODE_STATES.open,
        state: NODE_STATES.open,
        optOutFailures: () => [],
        conditionallyRequiredFields: () => [],
      };
    }
    const nodeChecks = nodeChecksOf(memo, node);
    return {
      fingerprint: nodeChecks.fingerprint,
      state: nodeChecks.state,
      optOutFailures: nodeChecks.optOutFailures,
      conditionallyRequiredFields: () => nodeChecks.conditionallyRequiredKeys()
        .map((key) => [...blockPath, key].join('.')),
    };
  }

  function nodeChecksOf(memo, node) {
    if (memo.nodes.has(node)) return memo.nodes.get(node);
    const { markedRoot } = memo;
    const nodeText = schemaText(markedRoot, node, memo);
    const open = nodeText === '{}';
    const nodeChecks = {
      fingerprint: open ? NODE_STATES.open : sha256Text(nodeText),
      state: open ? NODE_STATES.open : NODE_STATES.constrained,
      optOutFailures: lazily(() => (open ? [] : failuresOf(memo, node, null, new Set()))),
      conditionallyRequiredKeys: lazily(() => Object.entries(schemaNodeFields(markedRoot, node))
        .filter(([, field]) => isSchemaMap(field)
          && field[REQUIREMENT_MARKER_KEYWORD] === REQUIREMENT_MARKERS.conditionallyRequired)
        .map(([key]) => key)),
    };
    memo.nodes.set(node, nodeChecks);
    return nodeChecks;
  }

  function ownKeywordFailures(memo, node) {
    if (memo.ownKeywordFailures.has(node)) return memo.ownKeywordFailures.get(node);
    const ownKeywords = Object.fromEntries(Object.entries(node)
      .filter(([keyword]) => !COMBINING_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)));
    let failures = [];
    if (Object.keys(ownKeywords).length > 0) {
      const root = memo.markedRoot;
      const definitionKeywords = ['definitions', '$defs'].filter((keyword) => root[keyword] !== undefined);
      try {
        const validate = memo.ajv.compile({
          ...Object.fromEntries(definitionKeywords.map((keyword) => [keyword, root[keyword]])),
          ...ownKeywords,
        });
        failures = validate(EMPTY_MAP_OPT_OUT) ? [] : validate.errors.map((error) => messageFailure(error.message));
      } catch (error) {
        failures = [messageFailure(`the schema cannot be compiled: ${error.message}`)];
      }
    }
    memo.ownKeywordFailures.set(node, failures);
    return failures;
  }

  function failuresOf(memo, node, describedAs, refsFollowed) {
    if (node === false) return [messageFailure(NOT_ALLOWED_MESSAGE)];
    if (!isSchemaMap(node)) return [];
    const description = descriptionTextOf(node) || describedAs;
    const failures = [...ownKeywordFailures(memo, node)];
    if (typeof node.$ref === 'string' && !refsFollowed.has(node.$ref)) {
      const target = resolvePointer(memo.markedRoot, node.$ref);
      failures.push(...failuresOf(memo, target, description, new Set([...refsFollowed, node.$ref])));
    }
    for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
      failures.push(...failuresOf(memo, part, description, refsFollowed));
    }
    if (node.not !== undefined && failuresOf(memo, node.not, null, refsFollowed).length === 0) {
      failures.push(messageFailure(description || 'must NOT be valid'));
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      if (!Array.isArray(node[keyword])) continue;
      const alternatives = node[keyword].map((alternative) => failuresOf(memo, alternative, null, refsFollowed));
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

  return { nodeCheck };
}

module.exports = {
  FAILURE_KINDS,
  NODE_STATES,
  REQUIREMENT_MARKERS,
  createSchemaChecks,
};

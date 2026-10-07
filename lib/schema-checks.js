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

function dottedPath(blockPath, instancePath) {
  const steps = instancePath
    .split('/')
    .slice(1)
    .map((step) => step.replaceAll('~1', '/').replaceAll('~0', '~'));
  return [...blockPath, ...steps].join('.');
}

function requirementMarkerOf(node) {
  if (!node || typeof node !== 'object' || typeof node.description !== 'string') return null;
  const description = node.description.trimStart();
  return Object.values(REQUIREMENT_MARKERS).find((marker) => description.startsWith(marker)) || null;
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
        optOutMessages: () => [],
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
        optOutMessages: () => [`\`${blockPath.join('.')}\`: the schema does not allow it`],
        conditionallyRequiredFields: () => [],
      };
    }
    if (node === true) {
      return {
        fingerprint: NODE_STATES.open,
        state: NODE_STATES.open,
        optOutMessages: () => [],
        conditionallyRequiredFields: () => [],
      };
    }
    const nodeChecks = nodeChecksOf(memo, node);
    return {
      fingerprint: nodeChecks.fingerprint,
      state: nodeChecks.state,
      optOutMessages: () => nodeChecks.optOutFailures()
        .map((failure) => `\`${dottedPath(blockPath, failure.instancePath)}\`: ${failure.message}`),
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
      optOutFailures: lazily(() => (open ? [] : optOutFailuresOf(memo, node))),
      conditionallyRequiredKeys: lazily(() => Object.entries(schemaNodeFields(markedRoot, node))
        .filter(([, field]) => isSchemaMap(field)
          && field[REQUIREMENT_MARKER_KEYWORD] === REQUIREMENT_MARKERS.conditionallyRequired)
        .map(([key]) => key)),
    };
    memo.nodes.set(node, nodeChecks);
    return nodeChecks;
  }

  function optOutFailuresOf(memo, node) {
    const root = memo.markedRoot;
    let validate;
    try {
      const definitionKeywords = ['definitions', '$defs'].filter((keyword) => root[keyword] !== undefined);
      validate = memo.ajv.compile({
        ...Object.fromEntries(definitionKeywords.map((keyword) => [keyword, root[keyword]])),
        allOf: [node],
      });
    } catch (error) {
      return [{ instancePath: '', message: `the schema cannot be compiled: ${error.message}` }];
    }
    if (validate(EMPTY_MAP_OPT_OUT)) return [];
    const seen = new Set();
    return validate.errors
      .map((error) => ({ instancePath: error.instancePath, message: error.message }))
      .filter((failure) => {
        const key = `${failure.instancePath}\n${failure.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  return { nodeCheck };
}

module.exports = { NODE_STATES, REQUIREMENT_MARKERS, createSchemaChecks };

const { pointerSegmentsOf, schemaNodePointersOf, schemaNodeAt } = require('./schema-pointers');

const VALIDATOR_OPTIONS = {
  allErrors: true,
  strict: false,
  unicodeRegExp: true,
  validateSchema: false,
  validateFormats: false,
  logger: false,
  verbose: true,
};
const PART_SCHEMA_KEY_PREFIX = 'yaml-dsl-editor-part-';
const ROOT_REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef']);
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

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

function createSchemaValidator(root, draft, parser) {
  const ajv = new draft.ValidatorClass(VALIDATOR_OPTIONS);
  const conditionChecks = new Map();
  let pointersBySchemaNode = null;
  let partsCompiled = 0;

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

  return { compileRootPart, conditionHolds };
}

module.exports = { createSchemaValidator };

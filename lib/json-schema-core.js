const { JSON_SCHEMA_DRAFT_07 } = require('./json-schema-draft-07');
const { JSON_SCHEMA_DRAFT_2019_09 } = require('./json-schema-draft-2019-09');
const { JSON_SCHEMA_DRAFT_2020_12 } = require('./json-schema-draft-2020-12');

const JSON_SCHEMA_DRAFTS = [JSON_SCHEMA_DRAFT_07, JSON_SCHEMA_DRAFT_2019_09, JSON_SCHEMA_DRAFT_2020_12];
const ASSUMED_DRAFT = JSON_SCHEMA_DRAFT_07;
const OLDER_DRAFT_NAMES = ['draft-03', 'draft-04', 'draft-06'];
const OLDER_DRAFT_URIS = OLDER_DRAFT_NAMES.flatMap((name) => [
  `http://json-schema.org/${name}/schema#`,
  `http://json-schema.org/${name}/schema`,
]);
const SHAPE_MAP_KEYWORDS = ['patternProperties', 'properties'];
const VALUE_FORM_KEYWORDS = [
  'additionalProperties',
  'const',
  'enum',
  'items',
  'patternProperties',
  'prefixItems',
  'properties',
  'type',
];

const parsersBySchemaRoot = new WeakMap();

function isSchemaObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function draftOfSchema(root) {
  if (!isSchemaObject(root) || root.$schema === undefined || OLDER_DRAFT_URIS.includes(root.$schema)) {
    return ASSUMED_DRAFT;
  }
  return JSON_SCHEMA_DRAFTS.find((draft) => draft.schemaUris.includes(root.$schema)) || null;
}

function unreadDraftProblem(root) {
  if (draftOfSchema(root)) return null;
  const readDrafts = JSON_SCHEMA_DRAFTS.map((draft) => draft.name).join(', ');
  return `schema declares ${JSON.stringify(root.$schema)}, a draft the editor does not read; it reads ${readDrafts}`;
}

function pointerTarget(root, pointer) {
  let node = root;
  for (const part of pointer.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null;
    node = node[decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node == null ? null : node;
}

function collectAnchors(node, draft, anchors) {
  if (Array.isArray(node)) {
    for (const item of node) collectAnchors(item, draft, anchors);
    return;
  }
  if (!isSchemaObject(node)) return;
  for (const keyword of draft.anchorKeywords) {
    if (typeof node[keyword] === 'string' && !anchors.has(node[keyword])) anchors.set(node[keyword], node);
  }
  if (draft.plainNameIdAnchors && typeof node.$id === 'string' && node.$id.startsWith('#')) {
    anchors.set(node.$id.slice(1), node);
  }
  for (const value of Object.values(node)) collectAnchors(value, draft, anchors);
}

function openOrClosed(allowance) {
  if (allowance === false) return null;
  return isSchemaObject(allowance) ? allowance : true;
}

function patternMatch(patternProperties, key) {
  for (const [pattern, sub] of Object.entries(patternProperties || {})) {
    let expression;
    try {
      expression = new RegExp(pattern);
    } catch {
      continue;
    }
    if (expression.test(key)) return sub;
  }
  return undefined;
}

function createSchemaParser(root, draft) {
  let anchorsByName = null;
  const shapeSchemaKeywords = [
    ...new Set([draft.tupleItemsKeyword, draft.tupleRestKeyword, 'items', ...draft.unlistedPropertyKeywords]),
  ];

  function anchors() {
    if (!anchorsByName) {
      anchorsByName = new Map();
      collectAnchors(root, draft, anchorsByName);
    }
    return anchorsByName;
  }

  function resolveReference(reference) {
    if (typeof reference !== 'string') return null;
    if (reference === '#') return root;
    if (reference.startsWith('#/')) return pointerTarget(root, reference);
    if (reference.startsWith('#')) return anchors().get(decodeURIComponent(reference.slice(1))) || null;
    return null;
  }

  function referenceOf(node) {
    if (!isSchemaObject(node)) return null;
    const keyword = draft.referenceKeywords.find((candidate) => typeof node[candidate] === 'string');
    return keyword ? node[keyword] : null;
  }

  function conjunctionSchemasOf(node) {
    const listed = draft.conjunctionListKeywords
      .flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []));
    const mapped = draft.conjunctionMapKeywords
      .flatMap((keyword) => (isSchemaObject(node[keyword]) ? Object.values(node[keyword]) : []));
    return [...listed, ...mapped];
  }

  function combinedShape(left, right) {
    const shape = {};
    for (const keyword of SHAPE_MAP_KEYWORDS) shape[keyword] = { ...(left[keyword] || {}), ...(right[keyword] || {}) };
    for (const keyword of shapeSchemaKeywords) {
      shape[keyword] = right[keyword] !== undefined ? right[keyword] : left[keyword];
    }
    shape.required = [...new Set([...(left.required || []), ...(right.required || [])])];
    return shape;
  }

  function shapeOf(node, seenReferences) {
    if (!isSchemaObject(node)) return {};
    const reference = referenceOf(node);
    if (reference !== null) {
      if (seenReferences.has(reference)) return combinedShape(node, {});
      seenReferences.add(reference);
      return combinedShape(node, shapeOf(resolveReference(reference), seenReferences));
    }
    const parts = conjunctionSchemasOf(node);
    if (parts.length === 0) return node;
    let shape = {};
    for (const part of parts) shape = combinedShape(shape, shapeOf(part, seenReferences));
    return combinedShape(node, shape);
  }

  function itemSchemaAt(shape, index) {
    const tuple = shape[draft.tupleItemsKeyword];
    if (!Array.isArray(tuple)) return shape.items;
    return index < tuple.length ? tuple[index] : shape[draft.tupleRestKeyword];
  }

  function unlistedPropertySchema(shape) {
    const keyword = draft.unlistedPropertyKeywords.find((candidate) => shape[candidate] !== undefined);
    return keyword ? shape[keyword] : undefined;
  }

  function childSchemaOf(node, segment) {
    if (node === true) return true;
    const shape = shapeOf(node, new Set());
    if (typeof segment === 'number') return openOrClosed(itemSchemaAt(shape, segment));
    if (shape.properties && Object.hasOwn(shape.properties, segment)) return openOrClosed(shape.properties[segment]);
    const matched = patternMatch(shape.patternProperties, segment);
    if (matched !== undefined) return openOrClosed(matched);
    return openOrClosed(unlistedPropertySchema(shape));
  }

  function writtenFieldSchema(node, segment) {
    const shape = shapeOf(node, new Set());
    if (typeof segment === 'number') {
      const item = itemSchemaAt(shape, segment);
      return isSchemaObject(item) ? item : null;
    }
    if (shape.properties && Object.hasOwn(shape.properties, segment)) return shape.properties[segment];
    const matched = patternMatch(shape.patternProperties, segment);
    if (matched !== undefined) return matched;
    const unlisted = unlistedPropertySchema(shape);
    return isSchemaObject(unlisted) ? unlisted : null;
  }

  function nodeAt(path) {
    let node = root;
    for (const segment of path) {
      node = childSchemaOf(node, segment);
      if (node === null) return null;
    }
    return node;
  }

  function writtenFieldAt(path) {
    let node = root;
    for (const segment of path) {
      node = writtenFieldSchema(node, segment);
      if (!node) return null;
    }
    return node;
  }

  function fieldsOf(node) {
    if (!node || node === true) return {};
    return shapeOf(node, new Set()).properties || {};
  }

  function requiredKeysOf(node) {
    if (!node || node === true) return [];
    return shapeOf(node, new Set()).required || [];
  }

  function ownValueKeywords(node) {
    return Object.fromEntries(VALUE_FORM_KEYWORDS
      .filter((keyword) => node[keyword] !== undefined)
      .map((keyword) => [keyword, node[keyword]]));
  }

  function valueFormsOf(node, seenReferences) {
    if (!isSchemaObject(node)) return [{}];
    const joinedSchemas = draft.conjunctionListKeywords
      .flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []));
    const reference = referenceOf(node);
    if (reference !== null && !seenReferences.has(reference)) {
      seenReferences.add(reference);
      joinedSchemas.unshift(resolveReference(reference));
    }
    let forms = [ownValueKeywords(node)];
    for (const joined of joinedSchemas) {
      const joinedForms = valueFormsOf(joined, new Set(seenReferences));
      forms = forms.flatMap((form) => joinedForms.map((joinedForm) => ({ ...joinedForm, ...form })));
    }
    const alternatives = draft.alternativeListKeywords
      .flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []));
    if (alternatives.length === 0) return forms;
    return forms.flatMap((form) => alternatives
      .flatMap((alternative) => valueFormsOf(alternative, new Set(seenReferences)))
      .map((alternativeForm) => ({ ...form, ...alternativeForm })));
  }

  function valueFormsAt(path) {
    return valueFormsOf(nodeAt(path), new Set());
  }

  function fieldDescription(path) {
    const node = writtenFieldAt(path);
    return node && typeof node.description === 'string' ? node.description : null;
  }

  function fieldDeprecated(path) {
    if (!draft.readsDeprecated) return false;
    const seenReferences = new Set();
    let node = writtenFieldAt(path);
    while (isSchemaObject(node)) {
      if (node.deprecated === true) return true;
      const reference = referenceOf(node);
      if (reference === null || seenReferences.has(reference)) return false;
      seenReferences.add(reference);
      node = resolveReference(reference);
    }
    return false;
  }

  return {
    draft,
    root,
    resolveReference,
    referenceOf,
    nodeAt,
    fieldsOf,
    requiredKeysOf,
    valueFormsAt,
    fieldDescription,
    fieldDeprecated,
  };
}

function schemaParserFor(root) {
  if (!isSchemaObject(root)) return null;
  if (!parsersBySchemaRoot.has(root)) {
    const draft = draftOfSchema(root);
    parsersBySchemaRoot.set(root, draft ? createSchemaParser(root, draft) : null);
  }
  return parsersBySchemaRoot.get(root);
}

module.exports = {
  JSON_SCHEMA_DRAFTS,
  draftOfSchema,
  unreadDraftProblem,
  schemaParserFor,
};

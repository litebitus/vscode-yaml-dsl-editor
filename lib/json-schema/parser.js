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

const CONDITION_KEYWORD = 'if';
const CONSEQUENCE_KEYWORD = 'then';
const ALTERNATIVE_KEYWORD = 'else';
const NO_INSTANCE = Symbol('no instance');
const WITHOUT_DOCUMENT = { value: NO_INSTANCE, conditionHolds: null };

function isSchemaObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function jsonTypeOfInstance(instance) {
  if (instance === null) return 'null';
  if (Array.isArray(instance)) return 'array';
  if (Number.isInteger(instance)) return 'integer';
  return typeof instance;
}

function typeAdmits(statedType, instanceType) {
  const types = [].concat(statedType);
  return types.includes(instanceType) || (instanceType === 'integer' && types.includes('number'));
}

function childInstanceOf(instance, segment) {
  if (instance === null || typeof instance !== 'object') return NO_INSTANCE;
  return Object.hasOwn(instance, segment) ? instance[segment] : NO_INSTANCE;
}

const anchorsByRoot = new WeakMap();

function createSchemaParser(root, draft, document = WITHOUT_DOCUMENT) {
  const shapeSchemaKeywords = [
    ...new Set([
      draft.tupleItemsKeyword,
      draft.tupleRestKeyword,
      'items',
      'propertyNames',
      ...draft.unlistedPropertyKeywords,
    ]),
  ];

  function anchors() {
    if (!anchorsByRoot.has(root)) {
      const anchorsByName = new Map();
      collectAnchors(root, draft, anchorsByName);
      anchorsByRoot.set(root, anchorsByName);
    }
    return anchorsByRoot.get(root);
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

  function branchesOf(node, instance) {
    if (node[CONDITION_KEYWORD] === undefined) return [];
    const holds = instance === NO_INSTANCE || !document.conditionHolds
      ? null
      : document.conditionHolds(node[CONDITION_KEYWORD], instance);
    const keywords = holds === null
      ? [CONSEQUENCE_KEYWORD, ALTERNATIVE_KEYWORD]
      : [holds ? CONSEQUENCE_KEYWORD : ALTERNATIVE_KEYWORD];
    return keywords.map((keyword) => node[keyword]).filter(isSchemaObject);
  }

  function unitedSchemaMap(left = {}, right = {}) {
    const united = { ...left };
    for (const [key, schema] of Object.entries(right)) {
      const held = Object.hasOwn(united, key) ? united[key] : undefined;
      united[key] = isSchemaObject(held) && isSchemaObject(schema) && held !== schema
        ? { [draft.conjunctionListKeywords[0]]: [held, schema] }
        : schema;
    }
    return united;
  }

  function combinedSchemaMap(left = {}, right = {}) {
    const combined = { ...left, ...right };
    for (const [key, schema] of Object.entries(right)) {
      const held = Object.hasOwn(left, key) ? left[key] : undefined;
      const describedOnlyByHeld = isSchemaObject(held) && isSchemaObject(schema)
        && typeof held.description === 'string' && schema.description === undefined;
      if (describedOnlyByHeld) combined[key] = { description: held.description, ...schema };
    }
    return combined;
  }

  function unitedShape(left, right) {
    const shape = combinedShape(left, right);
    for (const keyword of SHAPE_MAP_KEYWORDS) shape[keyword] = unitedSchemaMap(left[keyword], right[keyword]);
    return shape;
  }

  function combinedShape(left, right) {
    const shape = {};
    for (const keyword of SHAPE_MAP_KEYWORDS) shape[keyword] = combinedSchemaMap(left[keyword], right[keyword]);
    for (const keyword of shapeSchemaKeywords) {
      shape[keyword] = right[keyword] !== undefined ? right[keyword] : left[keyword];
    }
    shape.required = [...new Set([...(left.required || []), ...(right.required || [])])];
    return shape;
  }

  function statedTypeOf(node, seenReferences = new Set()) {
    if (!isSchemaObject(node)) return undefined;
    if (node.type !== undefined) return node.type;
    const reference = referenceOf(node);
    if (reference === null || seenReferences.has(reference)) return undefined;
    return statedTypeOf(resolveReference(reference), new Set([...seenReferences, reference]));
  }

  function alternativesAdmitting(node, instance) {
    if (instance === NO_INSTANCE) return [];
    const instanceType = jsonTypeOfInstance(instance);
    return draft.alternativeListKeywords
      .flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []))
      .filter((alternative) => {
        const statedType = statedTypeOf(alternative);
        return statedType !== undefined && typeAdmits(statedType, instanceType);
      });
  }

  function shapeOf(node, seenReferences, instance) {
    if (!isSchemaObject(node)) return {};
    const reference = referenceOf(node);
    if (reference !== null) {
      if (seenReferences.has(reference)) return combinedShape(node, {});
      seenReferences.add(reference);
      return combinedShape(node, shapeOf(resolveReference(reference), seenReferences, instance));
    }
    const parts = conjunctionSchemasOf(node);
    const branches = branchesOf(node, instance);
    const alternatives = alternativesAdmitting(node, instance);
    if (parts.length === 0 && branches.length === 0 && alternatives.length === 0) return node;
    let shape = {};
    for (const part of parts) shape = combinedShape(shape, shapeOf(part, seenReferences, instance));
    if (branches.length > 0) {
      const branchShape = branches
        .map((branch) => shapeOf(branch, seenReferences, instance))
        .reduce(unitedShape);
      shape = combinedShape(shape, branchShape);
    }
    if (alternatives.length > 0) {
      const alternativeShape = alternatives
        .map((alternative) => shapeOf(alternative, new Set(seenReferences), instance))
        .reduce(unitedShape);
      shape = combinedShape(shape, { ...alternativeShape, required: [] });
    }
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

  function childSchemaOf(node, segment, instance) {
    if (node === true) return true;
    const shape = shapeOf(node, new Set(), instance);
    if (typeof segment === 'number') return openOrClosed(itemSchemaAt(shape, segment));
    if (shape.properties && Object.hasOwn(shape.properties, segment)) return openOrClosed(shape.properties[segment]);
    const matched = patternMatch(shape.patternProperties, segment);
    if (matched !== undefined) return openOrClosed(matched);
    return openOrClosed(unlistedPropertySchema(shape));
  }

  function writtenFieldSchema(node, segment, instance) {
    const shape = shapeOf(node, new Set(), instance);
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

  function instanceAt(path) {
    return path.reduce(childInstanceOf, document.value);
  }

  function nodeAt(path) {
    let node = document.start || root;
    let instance = document.value;
    for (const segment of path) {
      node = childSchemaOf(node, segment, instance);
      if (node === null) return null;
      instance = childInstanceOf(instance, segment);
    }
    return node;
  }

  function writtenFieldAt(path) {
    let node = document.start || root;
    let instance = document.value;
    for (const segment of path) {
      node = writtenFieldSchema(node, segment, instance);
      if (!node) return null;
      instance = childInstanceOf(instance, segment);
    }
    return node;
  }

  function fieldsOfInstance(node, instance) {
    if (!node || node === true) return {};
    return shapeOf(node, new Set(), instance).properties || {};
  }

  function requiredKeysOfInstance(node, instance) {
    if (!node || node === true) return [];
    return shapeOf(node, new Set(), instance).required || [];
  }

  function fieldsOf(node) {
    return fieldsOfInstance(node, NO_INSTANCE);
  }

  function requiredKeysOf(node) {
    return requiredKeysOfInstance(node, NO_INSTANCE);
  }

  function fieldsAt(path) {
    return fieldsOfInstance(nodeAt(path), instanceAt(path));
  }

  function requiredKeysAt(path) {
    return requiredKeysOfInstance(nodeAt(path), instanceAt(path));
  }

  function ownValueKeywords(node) {
    const keywords = VALUE_FORM_KEYWORDS.filter((keyword) => node[keyword] !== undefined);
    if (node.const !== undefined && typeof node.description === 'string') keywords.push('description');
    return Object.fromEntries(keywords.map((keyword) => [keyword, node[keyword]]));
  }

  function valueFormsOf(node, seenReferences, instance) {
    if (!isSchemaObject(node)) return [{}];
    const joinedSchemas = draft.conjunctionListKeywords
      .flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []));
    const branches = branchesOf(node, instance);
    const reference = referenceOf(node);
    if (reference !== null && !seenReferences.has(reference)) {
      seenReferences.add(reference);
      joinedSchemas.unshift(resolveReference(reference));
    }
    if (branches.length === 1) joinedSchemas.push(branches[0]);
    let forms = [ownValueKeywords(node)];
    for (const joined of joinedSchemas) {
      const joinedForms = valueFormsOf(joined, new Set(seenReferences), instance);
      forms = forms.flatMap((form) => joinedForms.map((joinedForm) => ({ ...joinedForm, ...form })));
    }
    const alternatives = draft.alternativeListKeywords
      .flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []));
    const alternativeGroups = [alternatives, branches.length > 1 ? branches : []].filter((group) => group.length > 0);
    for (const group of alternativeGroups) {
      const groupForms = group.flatMap((alternative) => valueFormsOf(alternative, new Set(seenReferences), instance));
      forms = forms.flatMap((form) => groupForms.map((alternativeForm) => ({ ...form, ...alternativeForm })));
    }
    return forms;
  }

  function valueFormsAt(path) {
    return valueFormsOf(nodeAt(path), new Set(), instanceAt(path));
  }

  function valueFormsOfSchema(schema) {
    return valueFormsOf(schema, new Set(), NO_INSTANCE);
  }

  function propertyNamesOf(keySchema) {
    if (!isSchemaObject(keySchema)) return null;
    if (typeof keySchema.const === 'string') return [keySchema.const];
    if (Array.isArray(keySchema.enum)) return keySchema.enum.filter((name) => typeof name === 'string');
    return null;
  }

  function openKeysAt(path) {
    const node = nodeAt(path);
    if (!isSchemaObject(node)) return [];
    const shape = shapeOf(node, new Set(), instanceAt(path));
    const listedNames = new Set(Object.keys(shape.properties || {}));
    const keyNames = propertyNamesOf(shape.propertyNames);
    if (keyNames) {
      return keyNames
        .filter((keyName) => !listedNames.has(keyName))
        .map((keyName) => ({ keyName, valueForms: valueFormsAt([...path, keyName]) }));
    }
    const unlisted = unlistedPropertySchema(shape);
    if (!isSchemaObject(unlisted) && unlisted !== true) return [];
    return [{ keyName: null, valueForms: valueFormsOfSchema(unlisted) }];
  }

  function conditionHoldsAt(path, condition) {
    const instance = instanceAt(path);
    if (instance === NO_INSTANCE || !document.conditionHolds) return null;
    return document.conditionHolds(condition, instance);
  }

  function boundToDocument(value, conditionHolds) {
    return createSchemaParser(root, draft, { ...document, value, conditionHolds });
  }

  function startingAt(pointer) {
    const start = pointer === '' ? root : resolveReference(`#${pointer}`);
    if (!isSchemaObject(start) && start !== true) return null;
    return createSchemaParser(root, draft, { ...document, start, readsFragment: true });
  }

  function fieldDescription(path) {
    const node = writtenFieldAt(path);
    return node && typeof node.description === 'string' ? node.description : null;
  }

  function writtenFieldSchemaAt(path) {
    return writtenFieldAt(path);
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

  function defaultValueOf(node) {
    const seenReferences = new Set();
    while (isSchemaObject(node)) {
      if (Object.hasOwn(node, 'default')) return { value: node.default };
      const reference = referenceOf(node);
      if (reference === null || seenReferences.has(reference)) return null;
      seenReferences.add(reference);
      node = resolveReference(reference);
    }
    return null;
  }

  return {
    draft,
    root,
    readsFragment: document.readsFragment === true,
    resolveReference,
    referenceOf,
    nodeAt,
    fieldsOf,
    requiredKeysOf,
    fieldsAt,
    requiredKeysAt,
    valueFormsAt,
    valueFormsOfSchema,
    openKeysAt,
    conditionHoldsAt,
    boundToDocument,
    startingAt,
    fieldDescription,
    writtenFieldSchemaAt,
    fieldDeprecated,
    defaultValueOf,
  };
}

module.exports = { isSchemaObject, createSchemaParser };

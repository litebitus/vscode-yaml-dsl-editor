function readModeline(text) {
  const match = String(text).match(/^\s*#\s*yaml-language-server:\s*\$schema=(\S+)/m);
  return match ? match[1] : null;
}

function parseSchema(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null;
    node = node[part];
  }
  return node == null ? null : node;
}

function combine(left, right) {
  const properties = { ...(left.properties || {}), ...(right.properties || {}) };
  const patternProperties = { ...(left.patternProperties || {}), ...(right.patternProperties || {}) };
  const additionalProperties = right.additionalProperties !== undefined
    ? right.additionalProperties
    : left.additionalProperties;
  const items = right.items !== undefined ? right.items : left.items;
  return { properties, patternProperties, additionalProperties, items };
}

// A field description written beside $ref is the tooltip. The $ref is followed
// only to keep walking; the composite's own description is not.
function structural(root, node, seen) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) return combine(node, {});
    seen.add(node.$ref);
    return combine(node, structural(root, resolvePointer(root, node.$ref), seen));
  }
  if (Array.isArray(node.allOf)) {
    let acc = {};
    for (const part of node.allOf) acc = combine(acc, structural(root, part, seen));
    return combine(node, acc);
  }
  return node;
}

function ownDescription(node) {
  if (node && typeof node === 'object' && !Array.isArray(node) && typeof node.description === 'string') {
    return node.description;
  }
  return null;
}

function step(root, node, segment) {
  const shape = structural(root, node, new Set());
  if (typeof segment === 'string') {
    if (shape.properties && Object.prototype.hasOwnProperty.call(shape.properties, segment)) {
      return shape.properties[segment];
    }
    if (shape.patternProperties) {
      for (const [pattern, sub] of Object.entries(shape.patternProperties)) {
        let re;
        try {
          re = new RegExp(pattern);
        } catch {
          continue;
        }
        if (re.test(segment)) return sub;
      }
    }
    if (shape.additionalProperties && typeof shape.additionalProperties === 'object') {
      return shape.additionalProperties;
    }
    return null;
  }
  if (typeof segment === 'number' && shape.items && typeof shape.items === 'object' && !Array.isArray(shape.items)) {
    return shape.items;
  }
  return null;
}

function openOrClosed(allowance) {
  if (allowance === false) return null;
  if (allowance && typeof allowance === 'object') return allowance;
  return true;
}

function childSchema(root, node, segment) {
  if (node === true) return true;
  const shape = structural(root, node, new Set());
  if (typeof segment === 'number') {
    if (Array.isArray(shape.items)) {
      return segment < shape.items.length ? shape.items[segment] : openOrClosed(node.additionalItems);
    }
    return openOrClosed(shape.items);
  }
  if (shape.properties && Object.prototype.hasOwnProperty.call(shape.properties, segment)) {
    return shape.properties[segment];
  }
  for (const [pattern, sub] of Object.entries(shape.patternProperties || {})) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      continue;
    }
    if (re.test(segment)) return sub;
  }
  return openOrClosed(shape.additionalProperties);
}

function schemaNodeAt(schema, path) {
  let node = schema;
  for (const segment of path) {
    node = childSchema(schema, node, segment);
    if (node === null) return null;
  }
  return node;
}

function schemaNodeFields(schema, node) {
  if (!node || node === true) return {};
  return structural(schema, node, new Set()).properties || {};
}

function fieldDescription(schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  let node = schema;
  for (const segment of path) {
    const next = step(schema, node, segment);
    if (!next) return null;
    node = next;
  }
  return ownDescription(node);
}

module.exports = {
  readModeline,
  parseSchema,
  resolvePointer,
  schemaNodeAt,
  schemaNodeFields,
  fieldDescription,
};

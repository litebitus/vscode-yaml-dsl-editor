const { schemaRendererFor } = require('./json-schema');
const { ANY_SHAPE } = require('./json-schema/render');
const { requirementMarkerOf, descriptionTextOf } = require('./schema-checks');
const { fieldRequirementOf } = require('./schema-completion');

function isSchemaMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fieldNameOf(path) {
  let keyIndex = path.length - 1;
  while (keyIndex >= 0 && typeof path[keyIndex] === 'number') keyIndex -= 1;
  const itemIndexes = path.slice(keyIndex + 1).map((index) => `[${index}]`).join('');
  return `${keyIndex >= 0 ? path[keyIndex] : ''}${itemIndexes}`;
}

function requirementOf(parser, path, node) {
  const key = path[path.length - 1];
  if (typeof key !== 'string') return requirementMarkerOf(node);
  const parent = parser.nodeAt(path.slice(0, -1));
  const requiredKeys = new Set(parent && parent !== true ? parser.requiredKeysOf(parent) : []);
  return fieldRequirementOf(node, key, requiredKeys);
}

function fieldDocumentationOf(parser, path) {
  const node = parser.writtenFieldSchemaAt(path);
  const renderer = schemaRendererFor(parser.root);
  if (!isSchemaMap(node) || !renderer) return null;
  const rendered = renderer.renderNode(node);
  const declaration = rendered.shape === ANY_SHAPE ? fieldNameOf(path) : `${fieldNameOf(path)}: ${rendered.shape}`;
  const requirement = requirementOf(parser, path, node);
  const signature = requirement ? `${declaration}    ${requirement}` : declaration;
  const sections = [`\`\`\`\n${signature}\n\`\`\``];
  const description = descriptionTextOf(node);
  if (description) sections.push(description);
  if (rendered.accepts.length > 0) sections.push(['*Accepts:*', ...rendered.accepts].join('\n'));
  const stated = parser.defaultValueOf(node);
  const tags = stated ? [...rendered.tags, `*Default:* \`${JSON.stringify(stated.value)}\``] : rendered.tags;
  const deprecated = node.deprecated === true && parser.draft.readsDeprecated ? ['*Deprecated*'] : [];
  const key = path[path.length - 1];
  const parent = parser.nodeAt(path.slice(0, -1));
  const parentConditions = typeof key === 'string' && parent && parent !== true
    ? renderer.keyConditionLinesOf(parent, key)
    : [];
  const tagLines = [...tags, ...rendered.conditions, ...parentConditions, ...deprecated];
  if (tagLines.length > 0) sections.push(tagLines.join('  \n'));
  return sections.join('\n\n');
}

module.exports = { fieldDocumentationOf };

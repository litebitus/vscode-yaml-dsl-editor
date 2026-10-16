const { unicodePatternOf } = require('./regex-patterns');

const INTRINSIC_FUNCTION_REFERENCE = '#/$defs/IntrinsicFunction';
const PROVIDER_ONLY_KEYWORDS = new Set(['insertionOrder', 'relationshipRef', 'arrayType']);
const DOCUMENTATION_KEYWORDS = ['title', 'description', 'default', 'deprecated'];
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
const SCHEMA_KEYWORDS = ['not', 'if', 'then', 'else', 'contains', 'propertyNames'];
const SCHEMA_MAP_KEYWORDS = ['definitions', '$defs'];

function isSchemaObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pointerSegmentOf(key) {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function topLevelPropertyNames(propertyPaths) {
  return new Set((propertyPaths || [])
    .map((propertyPath) => propertyPath.split('/'))
    .filter((segments) => segments.length === 3 && segments[1] === 'properties')
    .map((segments) => segments[2]));
}

function referenceIn(reference, context) {
  if (reference.startsWith('#/definitions/')) return `${context.typePointer}/$defs/${reference.slice(14)}`;
  if (reference.startsWith('#/properties/')) return `${context.typePointer}/properties/${reference.slice(13)}`;
  return reference;
}

function translatedPattern(pattern, context, where) {
  const translated = unicodePatternOf(pattern);
  if (translated.pattern === null) {
    context.leftOutPatterns.push({ typeName: context.typeName, where, pattern, problem: translated.problem });
  }
  return translated.pattern;
}

function mappedValues(map, mapValue) {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, mapValue(value, key)]));
}

function translatedPatternProperties(patternProperties, context, where) {
  const translated = {};
  for (const [keyPattern, schema] of Object.entries(patternProperties)) {
    const readKeyPattern = translatedPattern(keyPattern, context, `${where}/patternProperties`);
    if (readKeyPattern !== null) {
      translated[readKeyPattern] = valueSchemaOf(schema, context, `${where}/patternProperties`);
    }
  }
  return translated;
}

function attributeSchemaOf(reference, context) {
  if (!reference.startsWith('#/properties/')) return null;
  const name = reference.slice(13);
  return context.attributes.has(name) ? context.properties[name] : null;
}

function schemaOf(node, context, where) {
  if (!isSchemaObject(node)) return node;
  const written = {};
  for (const [keyword, value] of Object.entries(node)) {
    const at = `${where}/${keyword}`;
    if (PROVIDER_ONLY_KEYWORDS.has(keyword)) continue;
    const attributeSchema = keyword === '$ref' && typeof value === 'string' ? attributeSchemaOf(value, context) : null;
    if (attributeSchema) Object.assign(written, schemaOf(attributeSchema, context, at));
    else if (keyword === '$ref' && typeof value === 'string') written.$ref = referenceIn(value, context);
    else if (keyword === 'pattern' && typeof value === 'string') {
      const pattern = translatedPattern(value, context, at);
      if (pattern !== null) written.pattern = pattern;
    } else if (keyword === 'properties' && isSchemaObject(value)) {
      written.properties = mappedValues(value, (schema, name) => valueSchemaOf(schema, context, `${at}/${name}`));
    } else if (keyword === 'patternProperties' && isSchemaObject(value)) {
      written.patternProperties = translatedPatternProperties(value, context, where);
    } else if (keyword === 'additionalProperties' && isSchemaObject(value)) {
      written.additionalProperties = valueSchemaOf(value, context, at);
    } else if (keyword === 'items') {
      written.items = Array.isArray(value)
        ? value.map((item, index) => valueSchemaOf(item, context, `${at}/${index}`))
        : valueSchemaOf(value, context, at);
    } else if (SCHEMA_LIST_KEYWORDS.includes(keyword) && Array.isArray(value)) {
      written[keyword] = value.map((branch, index) => schemaOf(branch, context, `${at}/${index}`));
    } else if (SCHEMA_KEYWORDS.includes(keyword)) {
      written[keyword] = schemaOf(value, context, at);
    } else if (SCHEMA_MAP_KEYWORDS.includes(keyword) && isSchemaObject(value)) {
      written.$defs = mappedValues(value, (schema, name) => schemaOf(schema, context, `${at}/${name}`));
    } else {
      written[keyword] = value;
    }
  }
  return written;
}

function valueSchemaOf(node, context, where) {
  const schema = schemaOf(node, context, where);
  if (!isSchemaObject(schema)) return schema;
  const documentation = {};
  const shape = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (DOCUMENTATION_KEYWORDS.includes(keyword)) documentation[keyword] = value;
    else shape[keyword] = value;
  }
  return { ...documentation, anyOf: [shape, { $ref: INTRINSIC_FUNCTION_REFERENCE }] };
}

function resourceTypeDefinitionOf(provider, leftOutPatterns) {
  const attributes = topLevelPropertyNames(provider.readOnlyProperties);
  const context = {
    typeName: provider.typeName,
    typePointer: `#/$defs/${pointerSegmentOf(provider.typeName)}`,
    properties: provider.properties || {},
    attributes,
    leftOutPatterns,
  };
  const deprecated = topLevelPropertyNames(provider.deprecatedProperties);
  const properties = {};
  for (const [name, schema] of Object.entries(provider.properties || {})) {
    if (attributes.has(name)) continue;
    const valueSchema = valueSchemaOf(schema, context, `/properties/${name}`);
    properties[name] = deprecated.has(name) ? { ...valueSchema, deprecated: true } : valueSchema;
  }
  const definition = {
    description: provider.description,
    type: 'object',
    properties,
    additionalProperties: provider.additionalProperties === undefined ? false : provider.additionalProperties,
  };
  const required = (provider.required || []).filter((name) => !attributes.has(name));
  if (required.length > 0) definition.required = required;
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    if (Array.isArray(provider[keyword])) {
      definition[keyword] = provider[keyword].map((branch, index) => schemaOf(branch, context, `/${keyword}/${index}`));
    }
  }
  if (isSchemaObject(provider.definitions)) {
    definition.$defs = mappedValues(
      provider.definitions,
      (schema, name) => schemaOf(schema, context, `/definitions/${name}`),
    );
  }
  return definition;
}

module.exports = { INTRINSIC_FUNCTION_REFERENCE, pointerSegmentOf, resourceTypeDefinitionOf };

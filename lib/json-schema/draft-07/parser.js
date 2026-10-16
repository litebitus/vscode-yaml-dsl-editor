const JSON_SCHEMA_DRAFT_07 = {
  name: 'draft-07',
  schemaUris: ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema'],
  referenceKeywords: ['$ref'],
  anchorKeywords: [],
  plainNameIdAnchors: true,
  tupleItemsKeyword: 'items',
  tupleRestKeyword: 'additionalItems',
  unlistedPropertyKeywords: ['additionalProperties'],
  conjunctionListKeywords: ['allOf'],
  alternativeListKeywords: ['anyOf', 'oneOf'],
  conjunctionMapKeywords: [],
  dependencyMapKeywords: ['dependencies'],
  sameInstanceSchemaKeywords: ['else', 'if', 'not', 'then'],
  sameInstanceListKeywords: ['allOf', 'anyOf', 'oneOf'],
  childSchemaKeywords: ['additionalItems', 'additionalProperties', 'contains', 'items', 'propertyNames'],
  schemaMapKeywords: ['$defs', 'definitions', 'dependencies', 'patternProperties', 'properties'],
  readsDeprecated: false,
};

module.exports = { JSON_SCHEMA_DRAFT_07 };

const Ajv2019 = require('ajv/dist/2019');

const JSON_SCHEMA_DRAFT_2019_09 = {
  name: 'draft 2019-09',
  schemaUris: ['https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2019-09/schema#'],
  ValidatorClass: Ajv2019,
  referenceKeywords: ['$ref', '$recursiveRef'],
  anchorKeywords: ['$anchor'],
  plainNameIdAnchors: false,
  tupleItemsKeyword: 'items',
  tupleRestKeyword: 'additionalItems',
  unlistedPropertyKeywords: ['additionalProperties', 'unevaluatedProperties'],
  conjunctionListKeywords: ['allOf'],
  alternativeListKeywords: ['anyOf', 'oneOf'],
  conjunctionMapKeywords: ['dependentSchemas'],
  sameInstanceSchemaKeywords: ['else', 'if', 'not', 'then'],
  sameInstanceListKeywords: ['allOf', 'anyOf', 'oneOf'],
  childSchemaKeywords: [
    'additionalItems',
    'additionalProperties',
    'contains',
    'contentSchema',
    'items',
    'propertyNames',
    'unevaluatedItems',
    'unevaluatedProperties',
  ],
  schemaMapKeywords: ['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'],
  readsDeprecated: true,
};

module.exports = { JSON_SCHEMA_DRAFT_2019_09 };

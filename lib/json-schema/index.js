const { isSchemaObject, createSchemaParser } = require('./parser');
const { createSchemaValidator } = require('./validator');
const { createSchemaRenderer } = require('./render');
const { JSON_SCHEMA_DRAFT_07 } = require('./draft-07/parser');
const { JSON_SCHEMA_DRAFT_07_VALIDATOR } = require('./draft-07/validator');
const { JSON_SCHEMA_DRAFT_07_RENDERER } = require('./draft-07/render');
const { JSON_SCHEMA_DRAFT_2019_09 } = require('./draft-2019-09/parser');
const { JSON_SCHEMA_DRAFT_2019_09_VALIDATOR } = require('./draft-2019-09/validator');
const { JSON_SCHEMA_DRAFT_2019_09_RENDERER } = require('./draft-2019-09/render');
const { JSON_SCHEMA_DRAFT_2020_12 } = require('./draft-2020-12/parser');
const { JSON_SCHEMA_DRAFT_2020_12_VALIDATOR } = require('./draft-2020-12/validator');
const { JSON_SCHEMA_DRAFT_2020_12_RENDERER } = require('./draft-2020-12/render');

const JSON_SCHEMA_DRAFTS = [
  { ...JSON_SCHEMA_DRAFT_07, ...JSON_SCHEMA_DRAFT_07_VALIDATOR, ...JSON_SCHEMA_DRAFT_07_RENDERER },
  { ...JSON_SCHEMA_DRAFT_2019_09, ...JSON_SCHEMA_DRAFT_2019_09_VALIDATOR, ...JSON_SCHEMA_DRAFT_2019_09_RENDERER },
  { ...JSON_SCHEMA_DRAFT_2020_12, ...JSON_SCHEMA_DRAFT_2020_12_VALIDATOR, ...JSON_SCHEMA_DRAFT_2020_12_RENDERER },
];
const [ASSUMED_DRAFT] = JSON_SCHEMA_DRAFTS;
const OLDER_DRAFT_NAMES = ['draft-03', 'draft-04', 'draft-06'];
const OLDER_DRAFT_URIS = OLDER_DRAFT_NAMES.flatMap((name) => [
  `http://json-schema.org/${name}/schema#`,
  `http://json-schema.org/${name}/schema`,
]);

const parsersBySchemaRoot = new WeakMap();
const validatorsBySchemaRoot = new WeakMap();
const renderersBySchemaRoot = new WeakMap();

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

function cachedPerSchemaRoot(cacheBySchemaRoot, root, create) {
  if (!isSchemaObject(root)) return null;
  if (!cacheBySchemaRoot.has(root)) {
    const draft = draftOfSchema(root);
    cacheBySchemaRoot.set(root, draft ? create(root, draft) : null);
  }
  return cacheBySchemaRoot.get(root);
}

function schemaParserFor(root) {
  return cachedPerSchemaRoot(parsersBySchemaRoot, root, createSchemaParser);
}

function schemaParserForDocument(root, documentValue, fragmentPointer = null) {
  const rootParser = schemaParserFor(root);
  const parser = rootParser && fragmentPointer !== null ? rootParser.startingAt(fragmentPointer) : rootParser;
  if (!parser || documentValue === undefined) return parser;
  return parser.boundToDocument(documentValue, schemaValidatorFor(root).conditionHolds);
}

function schemaValidatorFor(root) {
  return cachedPerSchemaRoot(validatorsBySchemaRoot, root, (schemaRoot, draft) => (
    createSchemaValidator(schemaRoot, draft, schemaParserFor(schemaRoot))
  ));
}

function schemaRendererFor(root) {
  return cachedPerSchemaRoot(renderersBySchemaRoot, root, (schemaRoot, draft) => (
    createSchemaRenderer(draft, schemaParserFor(schemaRoot))
  ));
}

module.exports = {
  JSON_SCHEMA_DRAFTS,
  draftOfSchema,
  unreadDraftProblem,
  schemaParserFor,
  schemaParserForDocument,
  schemaValidatorFor,
  schemaRendererFor,
};

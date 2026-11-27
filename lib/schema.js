const SCHEMA_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function parseSchema(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function unreadSchemaProblem(schemaName, text) {
  try {
    JSON.parse(text);
  } catch (error) {
    return `schema ${schemaName}: ${error.message}`;
  }
  return `schema ${schemaName}: not a JSON object`;
}

function isSchemaUrl(location) {
  return SCHEMA_URL.test(location);
}

module.exports = {
  isSchemaUrl,
  parseSchema,
  unreadSchemaProblem,
};

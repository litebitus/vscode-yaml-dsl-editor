const MODELINE = /^(\s*#\s*yaml-language-server:\s*\$schema=)(\S+)/m;
const SCHEMA_URL = /^https?:\/\//;

function readModeline(text) {
  const match = String(text).match(MODELINE);
  return match ? match[2] : null;
}

function modelineSchemaSpanOf(text) {
  const source = String(text);
  const match = source.match(MODELINE);
  if (!match) return null;
  const start = match.index + match[1].length;
  return { spec: match[2], start, end: start + match[2].length };
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

function isSchemaUrl(spec) {
  return SCHEMA_URL.test(spec);
}

module.exports = {
  readModeline,
  modelineSchemaSpanOf,
  isSchemaUrl,
  parseSchema,
};

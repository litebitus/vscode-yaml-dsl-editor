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

module.exports = {
  readModeline,
  parseSchema,
};

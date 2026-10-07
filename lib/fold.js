const YAML = require('yaml');
const { deepMerge, isPlainObject } = require('./merge');

function foldDocument(overlayName, commonValue, overlayValue, overlayPresent) {
  const base = isPlainObject(commonValue) ? commonValue : {};
  const over = isPlainObject(overlayValue) ? overlayValue : {};
  const merged = deepMerge(base, over);
  const body = YAML.stringify(merged);
  const source = overlayPresent ? `the ${overlayName} overlay` : 'the common layer';
  return {
    text: `# ${overlayName} — common layer merged with ${source}\n${body}`,
    value: merged,
  };
}

module.exports = { foldDocument };

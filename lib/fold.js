const YAML = require('yaml');
const { deepMerge, isPlainObject } = require('./merge');

function foldDocument(environment, commonValue, overlayValue, overlayPresent) {
  const base = isPlainObject(commonValue) ? commonValue : {};
  const over = isPlainObject(overlayValue) ? overlayValue : {};
  const merged = deepMerge(base, over, 0);
  const body = YAML.stringify(merged);
  const source = overlayPresent ? `${environment}/resources.yml` : 'the common layer';
  return {
    text: `# ${environment} — common layer merged with ${source}\n${body}`,
    value: merged,
  };
}

module.exports = { foldDocument };

const YAML = require('yaml');

const FLOW_STYLE = { collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0 };
const SCALAR_STYLE = { lineWidth: 0 };

function flowValueText(value) {
  const isCollection = value !== null && typeof value === 'object';
  return YAML.stringify(value, isCollection ? FLOW_STYLE : SCALAR_STYLE).trimEnd();
}

module.exports = { flowValueText };

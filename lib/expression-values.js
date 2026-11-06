const { parseFunctionKey } = require('./function-calls');
const { holdsPlaceholder, matchWholeReference } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { tagOfKey } = require('./tag-keys');

function expressionCheck(dsl) {
  const markerFunction = dsl.function ? dsl.function.markerFunction : null;
  const wholeRules = (dsl.references || []).filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  return (text, isKey, keyedValue = null) => {
    if (isKey) {
      const parsed = parseFunctionKey(text, markerFunction);
      if (parsed) return parsed.name === null;
      const tag = tagOfKey(dsl.tagKeys, text);
      const keyedText = keyedValue && keyedValue.kind === 'scalar' ? String(keyedValue.value) : null;
      return Boolean(tag) && keyedText !== null && Boolean(matchWholeReference(`${tag} ${keyedText}`, wholeRules));
    }
    if (matchWholeReference(text, wholeRules)) return true;
    return holdsPlaceholder(text, dsl.placeholder);
  };
}

module.exports = { expressionCheck };

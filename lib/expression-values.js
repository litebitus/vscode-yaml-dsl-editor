const { parseFunctionKey } = require('./function-calls');
const { holdsPlaceholder, matchWholeReference } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { tagOfKey } = require('./tag-keys');

const EXPRESSION_KINDS = { reference: 'reference', call: 'call', template: 'template' };

function expressionKindReader(dsl) {
  const markerFunction = dsl.function ? dsl.function.markerFunction : null;
  const wholeRules = (dsl.references || []).filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  return (text, isKey, keyedValue = null) => {
    if (isKey) {
      const parsed = parseFunctionKey(text, markerFunction);
      if (parsed) return parsed.name === null ? EXPRESSION_KINDS.call : null;
      const tag = tagOfKey(dsl.tagKeys, text);
      const keyedText = keyedValue && keyedValue.kind === 'scalar' ? String(keyedValue.value) : null;
      const readsReference = Boolean(tag) && keyedText !== null
        && Boolean(matchWholeReference(`${tag} ${keyedText}`, wholeRules));
      return readsReference ? EXPRESSION_KINDS.reference : null;
    }
    if (matchWholeReference(text, wholeRules)) return EXPRESSION_KINDS.reference;
    return holdsPlaceholder(text, dsl.placeholder) ? EXPRESSION_KINDS.template : null;
  };
}

function expressionCheck(dsl) {
  const expressionKindOf = expressionKindReader(dsl);
  return (text, isKey, keyedValue = null) => expressionKindOf(text, isKey, keyedValue) !== null;
}

module.exports = { EXPRESSION_KINDS, expressionKindReader, expressionCheck };

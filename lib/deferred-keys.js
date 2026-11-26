const { matchWholeReferences, readsAt, scanPlaceholders } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { EXPRESSION_KINDS } = require('./expression-values');
const { localsScopeName } = require('./local-values');

function readsBuiltin(reading, dsl) {
  const scope = dsl.scopes ? dsl.scopes[reading.rule.scopeName] : null;
  return Boolean(scope) && scope.builtinNames.includes(reading.groups[reading.rule.nameGroup]);
}

function deferredKeyReaderOf(dsl, localValueTextOf = () => '') {
  const references = dsl.references || [];
  const wholeRules = references.filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  const localScopeName = localsScopeName(dsl);
  const textsBeingRead = new Set();

  function holdsDeferredPlaceholder(text) {
    let cursor = 0;
    for (const placeholder of scanPlaceholders(text, dsl.placeholder, references)) {
      if (placeholder.start < cursor) continue;
      cursor = placeholder.end;
      const readings = placeholder.readings.length > 0
        ? placeholder.readings
        : [placeholder.reference].filter(Boolean);
      if (readings.some((reading) => readsBuiltin(reading, dsl))) continue;
      const localReading = readings.find((reading) => reading.rule.scopeName === localScopeName);
      if (!localReading || !isConstantText(localValueTextOf(localReading))) return true;
    }
    return false;
  }

  function isConstantText(text) {
    if (text === null || text === undefined) return false;
    if (textsBeingRead.has(text)) return false;
    textsBeingRead.add(text);
    const deferredKind = deferredKeyKindOf(String(text));
    textsBeingRead.delete(text);
    return deferredKind === null;
  }

  function deferredKeyKindOf(key) {
    if (typeof key !== 'string') return null;
    const wholeReadings = matchWholeReferences(key, wholeRules);
    if (wholeReadings.some((reading) => readsAt(reading, WHOLE_SCALAR))) return EXPRESSION_KINDS.reference;
    return holdsDeferredPlaceholder(key) ? EXPRESSION_KINDS.template : null;
  }

  return deferredKeyKindOf;
}

function symbolsOfResolvedKeys(symbols, dsl, localValues) {
  const deferredKeyKindOf = deferredKeyReaderOf(dsl, (reading) => localValues.knownTextOf(reading));
  return symbols.filter((symbol) => !symbol.keyHoldingPlaceholder
    || deferredKeyKindOf(symbol.keyHoldingPlaceholder) === null);
}

module.exports = { deferredKeyReaderOf, symbolsOfResolvedKeys };

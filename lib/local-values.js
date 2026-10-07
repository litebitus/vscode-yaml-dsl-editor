const { matchWholeReferences, readsAt, scanPlaceholders } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');

function localsScopeName(dsl) {
  return dsl && dsl.locals ? dsl.locals.scopeName : null;
}

function scalarText(valueText) {
  const trimmed = String(valueText || '').trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]);
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function chosenDeclarations(stack, scopeName, activeFile) {
  const declarationsByName = new Map();
  for (const symbol of stack.symbols || []) {
    if (symbol.scopeName !== scopeName || symbol.everyName || typeof symbol.name !== 'string') continue;
    const listed = declarationsByName.get(symbol.name) || [];
    listed.push(symbol);
    declarationsByName.set(symbol.name, listed);
  }
  const chosen = new Map();
  for (const [name, declared] of declarationsByName) {
    chosen.set(name, declared.find((symbol) => symbol.file === activeFile)
      || declared.find((symbol) => symbol.file === stack.common)
      || declared[0]);
  }
  return chosen;
}

function localNameIn(reading, scopeName) {
  return reading.rule.scopeName === scopeName ? reading.groups[reading.rule.nameGroup] : null;
}

function createLocalValues(stack, activeFile) {
  const scopeName = localsScopeName(stack.dsl);
  const chosen = scopeName ? chosenDeclarations(stack, scopeName, activeFile) : new Map();
  const references = stack.dsl ? stack.dsl.references || [] : [];
  const wholeRules = references.filter((rule) => rule.scopeName === scopeName && rule.positions.includes(WHOLE_SCALAR));
  const values = new Map();
  const cyclic = new Set();
  const resolving = [];

  function valueOfName(name) {
    if (values.has(name)) return values.get(name);
    const symbol = chosen.get(name);
    if (!symbol) return null;
    const cycleStart = resolving.indexOf(name);
    if (cycleStart >= 0) {
      for (const member of resolving.slice(cycleStart)) cyclic.add(member);
      return null;
    }
    resolving.push(name);
    const resolved = resolvedText(symbol);
    resolving.pop();
    const value = cyclic.has(name)
      ? { symbol, text: scalarText(symbol.valueText), known: false }
      : { symbol, ...resolved };
    values.set(name, value);
    return value;
  }

  function resolvedText(symbol) {
    if (symbol.call || !symbol.valueIsScalar) return { text: symbol.valueText, known: false };
    const written = scalarText(symbol.valueText);
    const whole = matchWholeReferences(written, wholeRules).find((reading) => readsAt(reading, WHOLE_SCALAR));
    if (whole) {
      const target = valueOfName(localNameIn(whole, scopeName));
      return target && target.known ? { text: target.text, known: true } : { text: written, known: false };
    }
    let text = '';
    let cursor = 0;
    let known = true;
    for (const placeholder of scanPlaceholders(written, stack.dsl.placeholder, references)) {
      const reading = placeholder.readings.find((candidate) => localNameIn(candidate, scopeName) !== null);
      if (!reading) continue;
      const target = valueOfName(localNameIn(reading, scopeName));
      if (!target || !target.known) {
        known = false;
        continue;
      }
      text += written.slice(cursor, placeholder.start) + target.text;
      cursor = placeholder.end;
    }
    return { text: text + written.slice(cursor), known };
  }

  for (const name of chosen.keys()) valueOfName(name);

  return {
    scopeName,
    valueOf: (name) => values.get(name) || null,
    isCyclic: (name) => cyclic.has(name),
    declarations: () => [...chosen.values()],
  };
}

module.exports = { createLocalValues, localsScopeName, scalarText };

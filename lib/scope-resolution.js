const { spell } = require('./symbols');
const { scanPlaceholders } = require('./placeholder-scan');
const { pathMatches } = require('./document-path');
const { createLocalValues, localsScopeName } = require('./local-values');

function targetScopeOf(ref) {
  const { rule } = ref;
  return rule.scopeGroup ? ref.groups[rule.scopeGroup] : rule.scopeName;
}

function sameTarget(symbol, ref, symbolName = symbol.name) {
  if (symbol.scopeName !== ref.rule.scopeName) return false;
  if (symbol.scope !== targetScopeOf(ref)) return false;
  return symbol.everyName || symbolName === ref.groups[ref.rule.nameGroup];
}

function declaredScopeOf(symbol, dsl) {
  return dsl && dsl.scopes ? dsl.scopes[symbol.scopeName] || null : null;
}

function inRegions(regions, site) {
  const documentPath = site && site.documentPath ? site.documentPath : [];
  return regions.some((tokens) => pathMatches(tokens, documentPath, { includesSubtree: true }));
}

function listPosition(documentPath) {
  for (let index = documentPath.length - 1; index >= 0; index -= 1) {
    if (typeof documentPath[index] === 'number') {
      return { listPath: documentPath.slice(0, index), itemIndex: documentPath[index] };
    }
  }
  return null;
}

function followsInList(symbol, site) {
  if (!site || symbol.file !== site.file || !site.documentPath) return false;
  const position = listPosition(symbol.documentPath || []);
  if (!position) return false;
  const { listPath, itemIndex } = position;
  const inList = listPath.every((step, index) => site.documentPath[index] === step);
  const siteIndex = site.documentPath[listPath.length];
  return inList && typeof siteIndex === 'number' && siteIndex > itemIndex;
}

function isVisible(symbol, site, dsl) {
  const scope = declaredScopeOf(symbol, dsl);
  if (!scope) return false;
  return inRegions(scope.regions, site) || (scope.laterItemsOfDeclaringList && followsInList(symbol, site));
}

function localValuesOf(stack, activeFile) {
  return stack.localValues || createLocalValues(stack, activeFile);
}

function substitutedName(symbol, stack, activeFile) {
  const placeholder = stack.dsl && stack.dsl.placeholder;
  const scopeName = localsScopeName(stack.dsl);
  if (!placeholder || !scopeName || symbol.everyName || typeof symbol.name !== 'string') return null;
  const found = scanPlaceholders(symbol.name, placeholder, stack.dsl.references)
    .filter((scanned) => scanned.reference);
  if (found.length === 0) return null;
  const localValues = localValuesOf(stack, activeFile);
  let substituted = '';
  let cursor = 0;
  for (const scanned of found) {
    const reading = scanned.readings.find((candidate) => candidate.rule.scopeName === scopeName);
    const local = reading ? localValues.valueOf(reading.groups[reading.rule.nameGroup]) : null;
    if (!local || !local.known || local.text === '') return null;
    substituted += symbol.name.slice(cursor, scanned.start) + spell(local.text, symbol.nameSpelling);
    cursor = scanned.end;
  }
  return substituted + symbol.name.slice(cursor);
}

function pickSymbol(matches, activeFile, commonFile) {
  if (!matches || matches.length === 0) return null;
  return matches.find((symbol) => symbol.file === activeFile)
    || matches.find((symbol) => symbol.file === commonFile)
    || matches[0];
}

function builtinFor(ref, dsl) {
  const scopeName = ref.rule.scopeName;
  const scope = dsl && dsl.scopes ? dsl.scopes[scopeName] : null;
  const name = ref.groups[ref.rule.nameGroup];
  if (!scope || !scope.builtinNames.includes(name)) return null;
  if (!inRegions(scope.regions, { documentPath: ref.documentPath })) return null;
  return { builtin: true, scope: scopeName, name };
}

function readingsOf(ref) {
  if (!ref.alternatives || ref.alternatives.length === 0) return [ref];
  return ref.alternatives.map((alternative) => ({ ...ref, rule: alternative.rule, groups: alternative.groups }));
}

function resolveReading(stack, ref, activeFile) {
  const builtin = builtinFor(ref, stack.dsl);
  if (builtin) return builtin;
  const site = { file: ref.file, documentPath: ref.documentPath };
  const visible = stack.symbols.filter((symbol) => isVisible(symbol, site, stack.dsl));
  const matches = visible.filter((symbol) => sameTarget(symbol, ref));
  if (matches.length) return pickSymbol(matches, activeFile, stack.common);
  const substituted = visible.filter((symbol) => {
    const name = substitutedName(symbol, stack, activeFile);
    return name !== null && sameTarget(symbol, ref, name);
  });
  return pickSymbol(substituted, activeFile, stack.common);
}

function resolveInStack(stack, ref, activeFile) {
  for (const reading of readingsOf(ref)) {
    const resolved = resolveReading(stack, reading, activeFile);
    if (resolved) return resolved;
  }
  return null;
}

function resolveTargets(stack, ref, activeFile) {
  if (!stack.foldsHolding) {
    const resolved = resolveInStack(stack, ref, activeFile);
    return resolved ? [resolved] : [];
  }
  const targets = [];
  for (const fold of stack.foldsHolding(ref)) {
    const resolved = resolveInStack(fold.stack, ref, fold.file);
    if (!resolved) return [];
    if (resolved.builtin) return [resolved];
    if (!targets.includes(resolved)) targets.push(resolved);
  }
  return targets;
}

function resolveSymbol(stack, ref, activeFile) {
  return resolveTargets(stack, ref, activeFile)[0] || null;
}

module.exports = {
  targetScopeOf,
  isVisible,
  localValuesOf,
  substitutedName,
  resolveSymbol,
  resolveTargets,
};

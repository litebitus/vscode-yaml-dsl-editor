const { spell } = require('./symbols');
const { scanPlaceholders } = require('./placeholder-scan');
const { pathMatches } = require('./document-path');

function targetScopeOf(ref) {
  const { scope } = ref.target;
  return scope.literal || ref.groups[scope.group];
}

function sameTarget(symbol, ref, symbolName = symbol.name) {
  if (ref.target.scope.group && !symbol.scopeFromParent) return false;
  return symbol.scope === targetScopeOf(ref) && symbolName === ref.groups[ref.target.name];
}

function visibilityOf(symbol, dsl) {
  if (symbol.visibility) return symbol.visibility;
  const scope = dsl && dsl.scopes ? dsl.scopes[symbol.scope] : null;
  return scope ? scope.visibleFrom : null;
}

function listPosition(documentPath) {
  for (let index = documentPath.length - 1; index >= 0; index -= 1) {
    if (typeof documentPath[index] === 'number') {
      return { listPath: documentPath.slice(0, index), itemIndex: documentPath[index] };
    }
  }
  return null;
}

function isVisible(symbol, site, dsl) {
  const visibility = visibilityOf(symbol, dsl);
  if (!visibility) return false;
  if (visibility.kind === 'stack' || visibility.kind === 'everywhere') return true;
  if (!site || symbol.file !== site.file || !site.documentPath) return false;
  if (visibility.kind === 'paths') {
    return visibility.paths.some((tokens) => pathMatches(tokens, site.documentPath, { subtree: true }));
  }
  const position = listPosition(symbol.documentPath || []);
  if (!position) return false;
  const { listPath, itemIndex } = position;
  const inList = listPath.every((step, index) => site.documentPath[index] === step);
  const siteIndex = site.documentPath[listPath.length];
  return inList && typeof siteIndex === 'number' && siteIndex > itemIndex;
}

function scalarText(valueText) {
  const trimmed = String(valueText || '').trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]);
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function valuedSymbolFor(stack, placeholder, activeFile) {
  const { rule, groups } = placeholder.reference;
  const declared = stack.symbols.filter((symbol) => (
    symbol.valueIsScalar && sameTarget(symbol, { target: rule.target, groups })
  ));
  return declared.find((symbol) => symbol.file === activeFile)
    || declared.find((symbol) => symbol.file === stack.common)
    || declared[0]
    || null;
}

function substitutedName(symbol, stack, activeFile) {
  const placeholders = stack.dsl && stack.dsl.placeholders;
  if (!placeholders) return null;
  const found = scanPlaceholders(symbol.name, placeholders, stack.dsl.references)
    .filter((placeholder) => placeholder.reference);
  if (found.length === 0) return null;
  let substituted = '';
  let cursor = 0;
  for (const placeholder of found) {
    const valued = valuedSymbolFor(stack, placeholder, activeFile);
    const value = valued ? scalarText(valued.valueText) : '';
    if (!value) return null;
    substituted += symbol.name.slice(cursor, placeholder.start) + spell(value, symbol.spelling);
    cursor = placeholder.end;
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
  const scopeName = targetScopeOf(ref);
  const scope = dsl && dsl.scopes ? dsl.scopes[scopeName] : null;
  const name = ref.groups[ref.target.name];
  if (!scope || !scope.names || !scope.names.includes(name)) return null;
  return { builtin: true, scope: scopeName, name };
}

function resolveSymbol(stack, ref, activeFile) {
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

module.exports = {
  targetScopeOf,
  isVisible,
  substitutedName,
  resolveSymbol,
};

const path = require('path');
const { analyzeDocument } = require('./analyze');
const { targetScopeOf, resolveTargets } = require('./scope-resolution');
const { rangeBetween } = require('./range');
const { spell } = require('./symbols');
const { scanPlaceholders } = require('./placeholder-scan');
const { localsScopeName } = require('./local-values');

function referenceNameSpan(ref) {
  const span = (ref.span && ref.span.groups || []).find((group) => group.group === ref.rule.nameGroup);
  return span ? { start: span.start, end: span.end } : null;
}

function readsName(ref, scopeName, scope, name) {
  return ref.rule.scopeName === scopeName
    && targetScopeOf(ref) === scope
    && ref.groups[ref.rule.nameGroup] === name;
}

function sameScope(symbol, scopeName, scope) {
  return symbol.scopeName === scopeName && symbol.scope === scope && !symbol.everyName;
}

function writtenNameOf(symbol, text) {
  return symbol.writtenSpan ? text.slice(symbol.writtenSpan.start, symbol.writtenSpan.end) : null;
}

function madeOfLocal(writtenName, dsl) {
  const scopeName = localsScopeName(dsl);
  if (!scopeName || !dsl.placeholder) return false;
  return scanPlaceholders(writtenName, dsl.placeholder, dsl.references || []).some((found) => [
    ...(found.readings || []),
    ...(found.reference ? [found.reference] : []),
  ].some((reading) => reading.rule.scopeName === scopeName));
}

function renameRefusal(symbol, text, dsl) {
  if (!symbol) return 'nothing declares this name';
  if (symbol.builtin) return `${symbol.scope}.${symbol.name} is a builtin and cannot be renamed`;
  if (symbol.everyName) return `every name of ${symbol.scope} is declared at once here, so none can be renamed`;
  const writtenName = writtenNameOf(symbol, text);
  if (writtenName === null) return `${symbol.scope}.${symbol.name} is not written out where it is declared`;
  if (madeOfLocal(writtenName, dsl)) return `${symbol.scope}.${symbol.name} is made of a local's value`;
  return null;
}

function displayPathOf(filePath, data) {
  return data.dsl && data.dsl.dir ? path.relative(data.dsl.dir, filePath) : filePath;
}

function appliedText(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function pushEdit(editsByFile, filePath, edit) {
  if (!editsByFile.has(filePath)) editsByFile.set(filePath, []);
  const edits = editsByFile.get(filePath);
  if (!edits.some((existing) => existing.start < edit.end && edit.start < existing.end)) edits.push(edit);
}

function renameEdits(data, request) {
  const { scopeName, scope, oldName, newWrittenName, nameSpelling, keptDeclarations = [] } = request;
  if (!newWrittenName || !newWrittenName.trim()) return { problem: 'the new name is empty' };
  const newName = spell(newWrittenName, nameSpelling);
  const editsByFile = new Map();
  if (newName === oldName) return { edits: editsByFile };
  const declarations = data.symbols.filter((symbol) => sameScope(symbol, scopeName, scope) && symbol.name === oldName);
  const readers = [...data.files].flatMap(([filePath, doc]) => doc.references
    .filter((ref) => readsName(ref, scopeName, scope, oldName))
    .map((ref) => ({ filePath, ref })));
  if (declarations.length === 0 && readers.length === 0) return { edits: editsByFile };
  const clash = data.symbols.find((symbol) => sameScope(symbol, scopeName, scope)
    && symbol.name === newName && !keptDeclarations.includes(symbol));
  if (clash) return { problem: `${scope}.${newName} is already declared in ${displayPathOf(clash.file, data)}` };
  for (const declaration of declarations) {
    if (!declaration.writtenSpan) {
      return { problem: `${scope}.${oldName} is not written out in ${displayPathOf(declaration.file, data)}` };
    }
    pushEdit(editsByFile, declaration.file, { ...declaration.writtenSpan, text: newWrittenName });
  }
  for (const { filePath, ref } of readers) {
    const span = referenceNameSpan(ref);
    if (span) pushEdit(editsByFile, filePath, { ...span, text: newName });
  }
  for (const [filePath, edits] of editsByFile) {
    const doc = data.files.get(filePath);
    const after = analyzeDocument(appliedText(doc.text, edits), filePath, data.dsl);
    const declaredBefore = doc.symbols.filter((symbol) => sameScope(symbol, scopeName, scope)
      && (symbol.name === oldName || symbol.name === newName)).length;
    const declaredAfter = after.symbols.filter((symbol) => sameScope(symbol, scopeName, scope)
      && symbol.name === newName).length;
    const readBefore = doc.references.filter((ref) => readsName(ref, scopeName, scope, oldName)
      || readsName(ref, scopeName, scope, newName)).length;
    const readAfter = after.references.filter((ref) => readsName(ref, scopeName, scope, newName)).length;
    if (after.errors.length > doc.errors.length || declaredAfter !== declaredBefore || readAfter !== readBefore) {
      return { problem: `${newWrittenName} does not read back as ${scope}.${newName} in ${displayPathOf(filePath, data)}` };
    }
  }
  return { edits: editsByFile };
}

function holdsPosition(range, position) {
  const { start, end } = range;
  if (position.line < start.line || position.line > end.line) return false;
  if (position.line === start.line && position.character < start.character) return false;
  return !(position.line === end.line && position.character > end.character);
}

function renameSubjectAt(doc, position, stack) {
  for (const ref of doc.references) {
    const span = referenceNameSpan(ref);
    if (!span) continue;
    const range = rangeBetween(doc.text, span.start, span.end);
    if (!holdsPosition(range, position)) continue;
    return { symbol: resolveTargets(stack, ref, doc.filePath)[0] || null, range };
  }
  for (const symbol of doc.symbols) {
    if (!symbol.writtenSpan) continue;
    const range = rangeBetween(doc.text, symbol.writtenSpan.start, symbol.writtenSpan.end);
    if (holdsPosition(range, position)) return { symbol, range };
  }
  return null;
}

function renameLocationKey(symbol) {
  return JSON.stringify([symbol.scopeName, symbol.scope, symbol.documentPath.slice(0, -1), symbol.name]);
}

function renameableSymbols(symbols) {
  return symbols.filter((symbol) => symbol.writtenSpan && !symbol.everyName);
}

function renamedDeclarations(before, after) {
  const placeOf = (symbol) => JSON.stringify([symbol.scopeName, symbol.scope, symbol.documentPath.slice(0, -1)]);
  const namesByPlace = (symbols) => {
    const byPlace = new Map();
    for (const symbol of renameableSymbols(symbols)) {
      if (!byPlace.has(placeOf(symbol))) byPlace.set(placeOf(symbol), []);
      byPlace.get(placeOf(symbol)).push(symbol);
    }
    return byPlace;
  };
  const beforeByPlace = namesByPlace(before);
  const renamed = [];
  for (const [place, afterSymbols] of namesByPlace(after)) {
    const beforeSymbols = beforeByPlace.get(place) || [];
    const removed = beforeSymbols.filter((symbol) => !afterSymbols.some((other) => other.name === symbol.name));
    const added = afterSymbols.filter((symbol) => !beforeSymbols.some((other) => other.name === symbol.name));
    if (removed.length === 1 && added.length === 1) renamed.push({ from: removed[0], to: added[0] });
  }
  return renamed;
}

module.exports = {
  renameRefusal,
  renameEdits,
  renameSubjectAt,
  renameLocationKey,
  renamedDeclarations,
  writtenNameOf,
};

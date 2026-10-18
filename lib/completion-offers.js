const path = require('path');
const {
  templateFor,
  fillTemplate,
  placeholderShapesOf,
  wrapInPlaceholder,
} = require('./reference-template');
const { loopsEnclosing, loopVariableDocumentationOf } = require('./loops');
const { valueStarts } = require('./value-starts');
const { placeholderBodyRules } = require('./placeholder-scan');
const { isVisible, substitutedName } = require('./scope-resolution');
const {
  signatureText,
  functionDocumentationOf,
  tableEntryKindOf,
  tableEntriesOf,
  parseFunctionKey,
  calledEntryOf,
} = require('./function-calls');
const { WHOLE_SCALAR, ANYWHERE_IN_SCALAR } = require('./reference-positions');
const { tagOfKey } = require('./tag-keys');
const { typedValueKeyOf } = require('./schema-completion');
const { codeSpan } = require('./json-schema/render');

function sectionText(text, startLine) {
  const lines = String(text || '').split('\n');
  if (startLine < 0 || startLine >= lines.length) return '';
  const first = lines[startLine];
  const indent = first.match(/^\s*/)[0].length;
  const out = [first];
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (line.match(/^\s*/)[0].length <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

function displayPath(file, root) {
  if (!file || !root) return file || '';
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
}

function closingTextOf(template) {
  const lastPiece = template.pieces[template.pieces.length - 1];
  return lastPiece.literalText && template.pieces.length > 1 ? lastPiece.literalText : '';
}

function closedIn(typedText, template) {
  const closingText = closingTextOf(template);
  return Boolean(closingText) && typedText.slice(template.leadingText.length).includes(closingText);
}

function referenceStart(beforeCursor, template, valueOnly, tagPrefix = '') {
  const starts = valueOnly ? valueStarts(beforeCursor) : [...beforeCursor].map((_, index) => index);
  let found = -1;
  for (const start of starts) {
    if (start >= beforeCursor.length) continue;
    const typedText = `${tagPrefix}${beforeCursor.slice(start)}`;
    const typedLower = typedText.toLowerCase();
    const leadingLower = template.leadingText.toLowerCase();
    const opens = typedLower.startsWith(leadingLower) || leadingLower.startsWith(typedLower);
    if (opens && !closedIn(typedText, template)) found = Math.max(found, start);
  }
  return found;
}

function referableSymbols(stack, site, activeFile) {
  return stack.symbols
    .filter((symbol) => isVisible(symbol, site, stack.dsl))
    .map((symbol) => {
      const name = substitutedName(symbol, stack, activeFile);
      return name === null ? symbol : { ...symbol, name };
    });
}

function builtinSymbols(rule, dsl, site) {
  const { scopeName } = rule;
  const scope = dsl.scopes ? dsl.scopes[scopeName] : null;
  if (!scope || scope.builtinNames.length === 0 || !isVisible({ scopeName }, site, dsl)) return [];
  return scope.builtinNames.map((name) => ({ scope: scopeName, scopeName, name, builtin: true }));
}

function builtinDocumentationOf(name) {
  return `${codeSpan(name)}: *builtin*`;
}

function entryKind(symbol) {
  if (symbol.builtin) return 'builtin';
  return symbol.valueIsScalar ? 'value' : 'reference';
}

function filledEntries(rule, symbols, stack, site, wrap, insidePlaceholder) {
  const template = templateFor(rule, { leadingTextRequired: !insidePlaceholder });
  if (!template) return [];
  return [...builtinSymbols(rule, stack.dsl, site), ...symbols]
    .map((symbol) => {
      const filled = fillTemplate(template, symbol);
      return { text: filled ? wrap(filled) : null, kind: entryKind(symbol), symbol };
    })
    .filter((entry) => entry.text);
}

function completionOffers(stack, site, activeFile) {
  const symbols = referableSymbols(stack, site, activeFile);
  const offers = [];
  for (const rule of stack.dsl.references || []) {
    const anywhere = rule.positions.includes(ANYWHERE_IN_SCALAR);
    if (!rule.positions.includes(WHOLE_SCALAR) && !anywhere) continue;
    const template = templateFor(rule);
    if (template) {
      offers.push({
        template,
        valueOnly: !anywhere,
        entries: filledEntries(rule, symbols, stack, site, (text) => text, false),
      });
    }
  }
  const shapes = stack.dsl.placeholder ? placeholderShapesOf(stack.dsl.placeholder) : [];
  const enclosingLoops = loopsEnclosing(stack.loops || [], site.file, site.documentPath);
  for (const shape of shapes) {
    const wrap = (bodyText) => wrapInPlaceholder(shape, bodyText);
    const loopVariableEntries = enclosingLoops
      .map((loop) => ({ text: wrap(loop.loopVariable), kind: 'variable', symbol: { loop } }))
      .filter((entry) => entry.text);
    const entries = placeholderBodyRules(stack.dsl.references)
      .flatMap((rule) => filledEntries(rule, symbols, stack, site, wrap, true));
    offers.push({ template: shape, valueOnly: false, entries: [...loopVariableEntries, ...entries] });
  }
  return offers;
}

function completionItem(entry, stack, range) {
  const { symbol } = entry;
  if (symbol.loop) {
    return {
      label: entry.text,
      kind: 'variable',
      detail: 'loop variable',
      documentation: loopVariableDocumentationOf(symbol.loop),
      range,
    };
  }
  if (symbol.builtin) {
    return {
      label: entry.text,
      kind: 'builtin',
      detail: 'builtin',
      documentation: builtinDocumentationOf(symbol.name),
      range,
    };
  }
  const declaringDoc = stack.files.get(symbol.file);
  const section = declaringDoc && symbol.keyRange ? sectionText(declaringDoc.text, symbol.keyRange.start.line) : '';
  return {
    label: entry.text,
    kind: entry.kind,
    detail: displayPath(symbol.file, stack.root),
    documentation: section ? `\`\`\`yaml-dsl\n${section}\n\`\`\`` : '',
    range,
  };
}

function functionItemsOf(table, labelPrefix, range, offersEntry = () => true) {
  return tableEntriesOf(table).filter(([, entry]) => offersEntry(entry)).map(([functionName, entry]) => ({
    label: `${labelPrefix}${functionName}`,
    kind: 'function',
    detail: signatureText(functionName, entry),
    documentation: functionDocumentationOf(functionName, entry),
    range,
  }));
}

function functionCompletions(beforeCursor, position, stack) {
  const markerFunction = stack.dsl.function ? stack.dsl.function.markerFunction : null;
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  if (!markerFunction || !table) return [];
  const opened = beforeCursor.match(/(^\s*(?:-\s+)?|\s)([^\s[\]{},]*)$/);
  if (!opened || /:\s/.test(beforeCursor) || opened[2].startsWith('!')) return [];
  const start = beforeCursor.length - opened[2].length;
  const range = { start: { line: position.line, character: start }, end: position };
  return functionItemsOf(table, markerFunction.callMarker, range);
}

function calledEntryOfKey(key, stack) {
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  const markerFunction = stack.dsl.function ? stack.dsl.function.markerFunction : null;
  const parsed = markerFunction ? parseFunctionKey(key, markerFunction) : null;
  return table ? calledEntryOf(table, parsed ? parsed.functionName : key) : null;
}

function tagCompletions(beforeCursor, position, stack) {
  const tagKeys = stack.dsl.tagKeys || [];
  const start = valueStarts(beforeCursor).find((valueStart) => /^![^\s[\]{},]*$/.test(beforeCursor.slice(valueStart)));
  if (tagKeys.length === 0 || start === undefined) return [];
  const range = { start: { line: position.line, character: start }, end: position };
  return tagKeys.map(({ tag, key }) => {
    const called = calledEntryOfKey(key, stack);
    return {
      label: tag,
      kind: 'function',
      detail: called ? signatureText(called.calledName, called.entry) : key,
      documentation: called ? functionDocumentationOf(called.calledName, called.entry) : '',
      range,
    };
  });
}

function calleeCompletions(beforeCursor, position, site, stack) {
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  if (!site.calleeType || !table) return [];
  const typedName = beforeCursor.match(/[^\s[\]{},]*$/)[0];
  const start = beforeCursor.length - typedName.length;
  const range = { start: { line: position.line, character: start }, end: position };
  return functionItemsOf(table, '', range, (entry) => tableEntryKindOf(entry) === site.calleeType);
}

function completionsAt(lineText, position, site, stack, activeFile) {
  const beforeCursor = String(lineText || '').slice(0, position.character);
  const afterCursor = String(lineText || '').slice(position.character);
  const items = [
    ...functionCompletions(beforeCursor, position, stack),
    ...calleeCompletions(beforeCursor, position, site, stack),
    ...tagCompletions(beforeCursor, position, stack),
  ];
  const offered = new Set();
  const tag = tagOfKey(stack.dsl.tagKeys, typedValueKeyOf(beforeCursor));
  for (const offer of completionOffers(stack, site, activeFile)) {
    const writtenStart = referenceStart(beforeCursor, offer.template, offer.valueOnly);
    const tagPrefix = writtenStart < 0 && tag && offer.valueOnly ? `${tag} ` : '';
    const start = tagPrefix ? referenceStart(beforeCursor, offer.template, true, tagPrefix) : writtenStart;
    if (start < 0) continue;
    const closingText = closingTextOf(offer.template);
    const closesAfterCursor = Boolean(closingText) && afterCursor.startsWith(closingText);
    const end = closesAfterCursor
      ? { line: position.line, character: position.character + closingText.length }
      : position;
    const range = { start: { line: position.line, character: start }, end };
    for (const entry of offer.entries) {
      const text = entry.text.startsWith(tagPrefix) ? entry.text.slice(tagPrefix.length) : entry.text;
      if (offered.has(text)) continue;
      offered.add(text);
      items.push(completionItem({ ...entry, text }, stack, range));
    }
  }
  return items;
}

module.exports = { completionsAt, sectionText, displayPath, builtinDocumentationOf };

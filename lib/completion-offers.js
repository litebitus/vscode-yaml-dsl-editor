const path = require('path');
const { templateFor, fillTemplate } = require('./reference-template');
const { valueStarts } = require('./value-starts');
const { placeholderBodyRules } = require('./placeholder-scan');
const { isVisible, substitutedName } = require('./scope-resolution');
const { signatureText } = require('./function-calls');
const { WHOLE_SCALAR, ANYWHERE_IN_SCALAR } = require('./reference-positions');

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

function closedIn(typedText, template) {
  const lastPiece = template.pieces[template.pieces.length - 1];
  if (!lastPiece.literalText || template.pieces.length === 1) return false;
  return typedText.slice(template.leadingText.length).includes(lastPiece.literalText);
}

function referenceStart(beforeCursor, template, valueOnly) {
  const starts = valueOnly ? valueStarts(beforeCursor) : [...beforeCursor].map((_, index) => index);
  let found = -1;
  for (const start of starts) {
    if (start >= beforeCursor.length) continue;
    const typedText = beforeCursor.slice(start);
    const opens = typedText.startsWith(template.leadingText) || template.leadingText.startsWith(typedText);
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

const PLACEHOLDER_SCOPE = 'placeholder';

function placeholderShape(placeholder) {
  return templateFor({
    pattern: placeholder.pattern,
    positions: [ANYWHERE_IN_SCALAR],
    scopeName: PLACEHOLDER_SCOPE,
    scopeGroup: null,
    nameGroup: 'body',
  });
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
  const shape = stack.dsl.placeholder ? placeholderShape(stack.dsl.placeholder) : null;
  if (shape) {
    const wrap = (bodyText) => fillTemplate(shape, {
      scope: PLACEHOLDER_SCOPE,
      scopeName: PLACEHOLDER_SCOPE,
      name: bodyText,
    });
    const entries = placeholderBodyRules(stack.dsl.references)
      .flatMap((rule) => filledEntries(rule, symbols, stack, site, wrap, true));
    offers.push({ template: shape, valueOnly: false, entries });
  }
  return offers;
}

function completionItem(entry, stack, range) {
  const { symbol } = entry;
  if (symbol.builtin) {
    return { label: entry.text, kind: 'builtin', detail: `${symbol.scope} scope`, documentation: '', range };
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionCompletions(beforeCursor, position, stack) {
  const markerFunction = stack.dsl.function ? stack.dsl.function.markerFunction : null;
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  if (!markerFunction || !table) return [];
  const marker = escapeRegExp(markerFunction.callMarker);
  const opened = beforeCursor.match(new RegExp(`(^\\s*(?:-\\s+)?|\\s)(${marker}[A-Za-z0-9_:]*)$`));
  if (!opened) return [];
  const start = beforeCursor.length - opened[2].length;
  const range = { start: { line: position.line, character: start }, end: position };
  return Object.entries(table).map(([functionName, parameters]) => ({
    label: `${markerFunction.callMarker}${functionName}`,
    kind: 'function',
    detail: signatureText(functionName, parameters),
    documentation: '',
    range,
  }));
}

function completionsAt(lineText, position, site, stack, activeFile) {
  const beforeCursor = String(lineText || '').slice(0, position.character);
  const items = functionCompletions(beforeCursor, position, stack);
  const offered = new Set();
  for (const offer of completionOffers(stack, site, activeFile)) {
    const start = referenceStart(beforeCursor, offer.template, offer.valueOnly);
    if (start < 0) continue;
    const range = { start: { line: position.line, character: start }, end: position };
    for (const entry of offer.entries) {
      if (offered.has(entry.text)) continue;
      offered.add(entry.text);
      items.push(completionItem(entry, stack, range));
    }
  }
  return items;
}

module.exports = { completionsAt, sectionText, displayPath };

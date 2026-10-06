const path = require('path');
const { parseYaml } = require('./tree');
const { collectSymbols, collectReferences, spell } = require('./symbols');
const { fieldDescription } = require('./schema');
const { contains, indexToPos } = require('./range');
const { templateFor, fillTemplate } = require('./reference-template');
const { valueStarts } = require('./value-starts');
const { CONCEPT_KINDS, placeholderBodyRules, scanPlaceholders } = require('./placeholder-scan');

function analyzeDocument(text, filePath, dsl) {
  const parsed = parseYaml(text);
  const symbols = parsed.tree ? collectSymbols(parsed.tree, dsl.symbols, filePath, text) : [];
  const found = parsed.tree
    ? collectReferences(parsed.tree, dsl, filePath, text)
    : { references: [], placeholders: [] };
  return {
    filePath,
    text,
    tree: parsed.tree,
    errors: parsed.errors,
    symbols,
    references: found.references,
    placeholders: found.placeholders,
    value: parsed.value,
  };
}

function locate(node, position, pathKeys = []) {
  if (!node || !contains(node.range, position)) return null;
  if (node.kind === 'map') {
    for (const entry of node.entries) {
      if (entry.keyRange && contains(entry.keyRange, position)) {
        return { path: [...pathKeys, entry.key], range: entry.keyRange, node: entry.value };
      }
      const nextPath = entry.key == null ? pathKeys : [...pathKeys, entry.key];
      const inner = locate(entry.value, position, nextPath);
      if (inner) return inner;
    }
    return { path: pathKeys, range: node.range, node };
  }
  if (node.kind === 'seq') {
    for (let index = 0; index < node.items.length; index += 1) {
      const inner = locate(node.items[index], position, [...pathKeys, index]);
      if (inner) return inner;
    }
    return { path: pathKeys, range: node.range, node };
  }
  return { path: pathKeys, range: node.range, node };
}

function referenceAt(references, position) {
  return references.find((ref) => contains(ref.range, position)) || null;
}

function sameTarget(symbol, ref, symbolName = symbol.name) {
  if (symbol.kind !== ref.target.kind) return false;
  for (const [key, group] of Object.entries(ref.target)) {
    if (key === 'kind') continue;
    const wanted = ref.groups[group];
    if (key === 'name') {
      if (symbolName !== wanted) return false;
    } else if (symbol.qualifiers[key] !== wanted) return false;
  }
  return true;
}

function scalarText(valueText) {
  const trimmed = String(valueText || '').trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]);
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function localFor(stack, placeholder, activeFile) {
  const { rule, groups } = placeholder.reference;
  if (rule.target.kind !== CONCEPT_KINDS.local) return null;
  const declared = stack.symbols.filter((symbol) => sameTarget(symbol, { target: rule.target, groups }));
  return declared.find((symbol) => symbol.file === activeFile)
    || declared.find((symbol) => symbol.file === stack.common)
    || declared[0]
    || null;
}

function substitutedName(symbol, stack, activeFile) {
  const placeholders = stack.dsl && stack.dsl.placeholders;
  if (!placeholders) return null;
  const found = scanPlaceholders(symbol.name, placeholders, stack.dsl.references)
    .filter((placeholder) => placeholder.kind === 'reference');
  if (found.length === 0) return null;
  let substituted = '';
  let cursor = 0;
  for (const placeholder of found) {
    const local = localFor(stack, placeholder, activeFile);
    const value = local ? scalarText(local.valueText) : '';
    if (!value) return null;
    substituted += symbol.name.slice(cursor, placeholder.start) + spell(value, symbol.spelling);
    cursor = placeholder.end;
  }
  return substituted + symbol.name.slice(cursor);
}

function pickSymbol(matches, activeFile, commonFile) {
  if (!matches || matches.length === 0) return null;
  const common = matches.find((symbol) => symbol.file === commonFile);
  if (common) return common;
  const active = matches.find((symbol) => symbol.file === activeFile);
  if (active) return active;
  let best = null;
  for (const symbol of matches) {
    if (!best || symbol.file < best.file) best = symbol;
  }
  return best;
}

function resolveSymbol(stack, ref, activeFile) {
  const matches = stack.symbols.filter((symbol) => sameTarget(symbol, ref));
  if (matches.length) return pickSymbol(matches, activeFile, stack.common);
  const substituted = stack.symbols.filter((symbol) => {
    const name = substitutedName(symbol, stack, activeFile);
    return name !== null && sameTarget(symbol, ref, name);
  });
  return pickSymbol(substituted, activeFile, stack.common);
}

function plaintext(value, range) {
  return { contents: { kind: 'plaintext', value }, range };
}

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

function withSection(value, ref, target, files, root) {
  if (!target || !files) return plaintext(value, ref.range);
  const doc = files.get(target.file);
  if (!doc || !target.keyRange) return plaintext(value, ref.range);
  const code = sectionText(doc.text, target.keyRange.start.line);
  if (!code) return plaintext(value, ref.range);
  const line = target.keyRange.start.line + 1;
  const title = `${displayPath(target.file, root)}:${line}`;
  return {
    contents: {
      kind: 'markdown',
      value: `[${title}](${pathToUri(target.file)}#L${line})\n\n\`\`\`yaml-dsl\n${code}\n\`\`\``,
    },
    range: ref.range,
  };
}

function referenceHover(ref, target, files, root) {
  if (ref.target.kind === CONCEPT_KINDS.local) {
    const value = target ? target.valueText : (ref.groups.name || '');
    return withSection(value, ref, target, files, root);
  }
  const type = ref.groups.type;
  const name = ref.groups.name || '';
  let value = type ? `${type}.${name}` : name;
  if (target) value = `${value} — ${displayPath(target.file, root)}`;
  return withSection(value, ref, target, files, root);
}

function hoverAt(doc, position, stack, schema) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (ref) {
    const target = resolveSymbol(stack, ref, doc.filePath);
    return referenceHover(ref, target, stack.files, stack.root);
  }
  const located = locate(doc.tree, position);
  if (!located || !schema) return null;
  const description = fieldDescription(schema, located.path);
  if (!description) return null;
  return plaintext(description, located.range);
}

function definitionAt(doc, position, stack) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (!ref) return null;
  const target = resolveSymbol(stack, ref, doc.filePath);
  if (!target) return null;
  return { path: target.file, range: target.keyRange, origin: ref.range };
}

function linksFor(doc, stack) {
  if (!doc) return [];
  const links = [];
  for (const ref of doc.references) {
    const target = resolveSymbol(stack, ref, doc.filePath);
    if (!target) continue;
    links.push({ range: ref.range, path: target.file, targetRange: target.keyRange });
  }
  return links;
}

function closedIn(typedText, template) {
  const lastPiece = template.pieces[template.pieces.length - 1];
  if (!lastPiece.literalText || template.pieces.length === 1) return false;
  return typedText.slice(template.leadingText.length).includes(lastPiece.literalText);
}

function referenceStart(beforeCursor, template) {
  const starts = template.rule.where === 'whole'
    ? valueStarts(beforeCursor)
    : [...beforeCursor].map((_, index) => index);
  let found = -1;
  for (const start of starts) {
    if (start >= beforeCursor.length) continue;
    const typedText = beforeCursor.slice(start);
    const opens = typedText.startsWith(template.leadingText)
      || template.leadingText.startsWith(typedText);
    if (opens && !closedIn(typedText, template)) found = Math.max(found, start);
  }
  return found;
}

function referableSymbols(stack, symbols, activeFile) {
  return symbols.map((symbol) => {
    const name = substitutedName(symbol, stack, activeFile);
    return name === null ? symbol : { ...symbol, name };
  });
}

function placeholderShape(placeholders) {
  return templateFor({
    pattern: placeholders.pattern,
    where: 'within',
    target: { kind: 'placeholder', body: 'body' },
  });
}

function wrappedInPlaceholder(shape, bodyText) {
  return fillTemplate(shape, { kind: 'placeholder', qualifiers: { body: bodyText } });
}

function completionOffers(stack, symbols, activeFile) {
  const referable = referableSymbols(stack, symbols, activeFile);
  const offers = [];
  for (const rule of stack.dsl.references || []) {
    const template = templateFor(rule);
    if (!template) continue;
    const entries = referable
      .map((symbol) => ({ text: fillTemplate(template, symbol), kind: symbol.kind, symbol }))
      .filter((entry) => entry.text);
    offers.push({ template, entries });
  }
  const placeholders = stack.dsl.placeholders;
  const shape = placeholders ? placeholderShape(placeholders) : null;
  if (shape) {
    const entries = placeholders.builtins
      .map((builtin) => ({ text: wrappedInPlaceholder(shape, builtin), kind: 'builtin' }));
    for (const rule of placeholderBodyRules(placeholders, stack.dsl.references)) {
      const template = templateFor(rule);
      if (!template) continue;
      for (const symbol of referable) {
        const bodyText = fillTemplate(template, symbol);
        if (bodyText) entries.push({ text: wrappedInPlaceholder(shape, bodyText), kind: symbol.kind, symbol });
      }
    }
    offers.push({ template: shape, entries: entries.filter((entry) => entry.text) });
  }
  return offers;
}

function completionItem(entry, stack, range) {
  if (!entry.symbol) {
    return { label: entry.text, kind: entry.kind, detail: 'builtin placeholder', documentation: '', range };
  }
  const declaringDoc = stack.files.get(entry.symbol.file);
  const section = declaringDoc && entry.symbol.keyRange
    ? sectionText(declaringDoc.text, entry.symbol.keyRange.start.line)
    : '';
  return {
    label: entry.text,
    kind: entry.kind,
    detail: displayPath(entry.symbol.file, stack.root),
    documentation: section ? `\`\`\`yaml-dsl\n${section}\n\`\`\`` : '',
    range,
  };
}

function completionsAt(lineText, position, symbols, stack, activeFile) {
  const beforeCursor = String(lineText || '').slice(0, position.character);
  const items = [];
  const offered = new Set();
  for (const offer of completionOffers(stack, symbols, activeFile)) {
    const start = referenceStart(beforeCursor, offer.template);
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

function classifiedReferences(doc, stack) {
  if (!doc) return [];
  return doc.references.map((ref) => {
    const target = resolveSymbol(stack, ref, doc.filePath);
    if (!target) return { range: ref.range, kind: 'error' };
    return { range: ref.range, kind: target.file === doc.filePath ? 'local' : 'external' };
  });
}

const TOKEN_TYPES = ['keyword', 'operator', 'type', 'variable'];
const TOKEN_MODIFIERS = ['defaultLibrary'];

function literalType(start, spanStart) {
  return start === spanStart ? 'keyword' : 'operator';
}

function referenceTokens(ref) {
  if (!ref.span) return [];
  const targetGroups = new Set(Object.entries(ref.target).filter(([key]) => key !== 'kind').map(([, group]) => group));
  const groups = ref.span.groups
    .filter((group) => targetGroups.has(group.group) && group.end > group.start)
    .sort((left, right) => left.start - right.start);
  const tokens = [];
  let cursor = ref.span.start;
  const pushLiteral = (end) => {
    if (end > cursor) tokens.push({ start: cursor, end, type: literalType(cursor, ref.span.start) });
  };
  for (const group of groups) {
    pushLiteral(group.start);
    tokens.push({ start: group.start, end: group.end, type: group.group === ref.target.name ? 'variable' : 'type' });
    cursor = Math.max(cursor, group.end);
  }
  pushLiteral(ref.span.end);
  return tokens;
}

function placeholderTokens(placeholder) {
  const tokens = [
    { start: placeholder.start, end: placeholder.bodyStart, type: 'operator' },
    { start: placeholder.bodyEnd, end: placeholder.end, type: 'operator' },
  ];
  if (placeholder.kind === 'builtin') {
    tokens.push({
      start: placeholder.bodyStart,
      end: placeholder.bodyEnd,
      type: 'variable',
      modifiers: ['defaultLibrary'],
    });
  }
  return tokens.filter((token) => token.end > token.start);
}

function outsidePlaceholders(token, ref, placeholders) {
  let pieces = [token];
  for (const placeholder of placeholders) {
    if (ref.span.start >= placeholder.bodyStart && ref.span.end <= placeholder.bodyEnd) continue;
    pieces = pieces.flatMap((piece) => {
      if (placeholder.end <= piece.start || placeholder.start >= piece.end) return [piece];
      return [
        { ...piece, end: placeholder.start },
        { ...piece, start: placeholder.end },
      ].filter((part) => part.end > part.start);
    });
  }
  return pieces;
}

function semanticTokensFor(doc) {
  if (!doc) return [];
  const placeholders = doc.placeholders || [];
  const tokens = placeholders.flatMap(placeholderTokens);
  for (const ref of doc.references) {
    for (const token of referenceTokens(ref)) tokens.push(...outsidePlaceholders(token, ref, placeholders));
  }
  const placed = [];
  for (const token of tokens.sort((left, right) => left.start - right.start)) {
    const start = indexToPos(doc.text, token.start);
    const end = indexToPos(doc.text, token.end);
    if (start.line !== end.line) continue;
    const previous = placed[placed.length - 1];
    if (previous && previous.offsetEnd > token.start) continue;
    placed.push({
      line: start.line,
      character: start.character,
      length: end.character - start.character,
      type: token.type,
      modifiers: token.modifiers || [],
      offsetEnd: token.end,
    });
  }
  return placed.map(({ offsetEnd, ...token }) => token);
}

function linkTarget(filePath, range) {
  const end = range.end || range.start;
  return `${pathToUri(filePath)}#${range.start.line + 1},${range.start.character + 1},${end.line + 1},${end.character + 1}`;
}

function pathToUri(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

function uriToPath(uri) {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.slice('file://'.length));
}

module.exports = {
  analyzeDocument,
  hoverAt,
  definitionAt,
  linksFor,
  classifiedReferences,
  completionsAt,
  semanticTokensFor,
  TOKEN_TYPES,
  TOKEN_MODIFIERS,
  linkTarget,
  pathToUri,
  uriToPath,
};

const { indexToPos } = require('./range');

const TOKEN_TYPES = ['function', 'keyword', 'operator', 'type', 'variable'];
const TOKEN_MODIFIERS = ['defaultLibrary'];

function literalType(start, spanStart) {
  return start === spanStart ? 'keyword' : 'operator';
}

function referenceTokens(ref, builtin) {
  if (!ref.span) return [];
  const targetGroups = new Set([ref.rule.nameGroup, ref.rule.scopeGroup].filter(Boolean));
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
    const isName = group.group === ref.rule.nameGroup;
    tokens.push({
      start: group.start,
      end: group.end,
      type: isName ? 'variable' : 'type',
      modifiers: isName && builtin ? ['defaultLibrary'] : [],
    });
    cursor = Math.max(cursor, group.end);
  }
  pushLiteral(ref.span.end);
  return tokens;
}

function placeholderTokens(placeholder) {
  return [
    { start: placeholder.start, end: placeholder.bodyStart, type: 'operator' },
    { start: placeholder.bodyEnd, end: placeholder.end, type: 'operator' },
  ].filter((token) => token.end > token.start);
}

function callTokens(call, offsetOf) {
  return [
    { start: offsetOf(call.markerRange.start), end: offsetOf(call.markerRange.end), type: 'keyword' },
    { start: offsetOf(call.functionRange.start), end: offsetOf(call.functionRange.end), type: 'function' },
    { start: offsetOf(call.splatRange.start), end: offsetOf(call.splatRange.end), type: 'operator' },
  ].filter((token) => token.end > token.start);
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

function lineOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function semanticTokensFor(doc, isBuiltin) {
  if (!doc) return [];
  const placeholders = (doc.placeholders || []).filter((placeholder) => placeholder.valid);
  const starts = lineOffsets(doc.text);
  const offsetOf = (position) => starts[position.line] + position.character;
  const tokens = placeholders.flatMap(placeholderTokens);
  for (const ref of doc.references) {
    for (const token of referenceTokens(ref, isBuiltin(ref))) {
      tokens.push(...outsidePlaceholders(token, ref, placeholders));
    }
  }
  for (const call of doc.calls || []) tokens.push(...callTokens(call, offsetOf));
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

module.exports = { TOKEN_TYPES, TOKEN_MODIFIERS, semanticTokensFor };

const { rangeBetween } = require('./range');
const { matchWholeReference, scanPlaceholders } = require('./placeholder-scan');

function parseAt(at) {
  if (typeof at !== 'string' || !at.startsWith('$')) return null;
  const tokens = [];
  let index = 1;
  while (index < at.length) {
    if (at[index] === '.') {
      index += 1;
      if (at[index] === '*') {
        tokens.push({ kind: 'star' });
        index += 1;
        continue;
      }
      let key = '';
      while (index < at.length && at[index] !== '.' && at[index] !== '[') {
        key += at[index];
        index += 1;
      }
      if (!key) return null;
      tokens.push({ kind: 'key', key });
      continue;
    }
    if (at.startsWith('[*]', index)) {
      tokens.push({ kind: 'index' });
      index += 3;
      continue;
    }
    return null;
  }
  return tokens;
}

function spell(text, spelling) {
  return spelling === 'snake' ? text.replaceAll('-', '_') : text;
}

function symbolName(key, name) {
  let raw = key;
  const parts = key.split(/\s+/).filter(Boolean);
  if (name.token === 'last' && parts.length) raw = parts[parts.length - 1];
  if (name.token === 'first' && parts.length) [raw] = parts;
  return spell(raw, name.spelling);
}

function emit(entry, trail, rule, filePath, text, symbols) {
  if (entry.key == null) return;
  const qualifiers = {};
  const parent = trail.length ? trail[trail.length - 1].key : null;
  for (const [key, source] of Object.entries(rule.qualify)) {
    if (source === 'parent') qualifiers[key] = parent;
  }
  const value = entry.value;
  symbols.push({
    kind: rule.kind,
    name: symbolName(entry.key, rule.name),
    spelling: rule.name.spelling,
    qualifiers,
    file: filePath,
    keyRange: entry.keyRange,
    valueText: value ? text.slice(value.start, value.end) : '',
  });
}

function walk(node, tokens, trail, rule, filePath, text, symbols) {
  if (!node || tokens.length === 0) return;
  const [token, ...rest] = tokens;
  if (token.kind === 'key') {
    if (node.kind !== 'map') return;
    const entry = node.entries.find((item) => item.key === token.key);
    if (!entry) return;
    if (rest.length === 0) emit(entry, trail, rule, filePath, text, symbols);
    else walk(entry.value, rest, [...trail, entry], rule, filePath, text, symbols);
    return;
  }
  if (token.kind === 'star') {
    if (node.kind !== 'map') return;
    for (const entry of node.entries) {
      if (entry.key == null) continue;
      if (rest.length === 0) {
        if (rule.exclude.includes(entry.key)) continue;
        emit(entry, trail, rule, filePath, text, symbols);
      } else if (!rule.skip.includes(entry.key)) {
        walk(entry.value, rest, [...trail, entry], rule, filePath, text, symbols);
      }
    }
    return;
  }
  if (token.kind === 'index') {
    if (node.kind !== 'seq') return;
    for (const item of node.items) {
      if (rest.length === 0) continue;
      walk(item, rest, trail, rule, filePath, text, symbols);
    }
  }
}

function collectSymbols(tree, rules, filePath, text) {
  const symbols = [];
  for (const rule of rules) {
    const tokens = parseAt(rule.at);
    if (!tokens) continue;
    walk(tree, tokens, [], rule, filePath, text, symbols);
  }
  return symbols;
}

function walkScalars(node, visit) {
  if (!node) return;
  if (node.kind === 'scalar') {
    visit(node);
    return;
  }
  if (node.kind === 'map') {
    for (const entry of node.entries) walkScalars(entry.value, visit);
    return;
  }
  if (node.kind === 'seq') {
    for (const item of node.items) walkScalars(item, visit);
  }
}

function referenceFrom(match, target, text, filePath) {
  return {
    target,
    groups: match.groups,
    range: rangeBetween(text, match.span.start, match.span.end),
    span: match.span,
    file: filePath,
  };
}

function pushWithin(found, rule, raw, origin, filePath, text) {
  for (const match of raw.matchAll(new RegExp(rule.pattern, 'gd'))) {
    if (match[0].length === 0) continue;
    const start = origin + match.index;
    const groups = [];
    for (const [group, span] of Object.entries((match.indices && match.indices.groups) || {})) {
      if (span) groups.push({ group, start: origin + span[0], end: origin + span[1] });
    }
    const span = { start, end: start + match[0].length, groups };
    found.references.push(referenceFrom({ groups: match.groups || {}, span }, rule.target, text, filePath));
  }
}

function pushPlaceholders(found, dsl, raw, origin, filePath, text) {
  for (const placeholder of scanPlaceholders(raw, dsl.placeholders, dsl.references, origin)) {
    found.placeholders.push({
      ...placeholder,
      range: rangeBetween(text, placeholder.start, placeholder.end),
    });
    if (placeholder.kind === 'reference') {
      const { reference } = placeholder;
      found.references.push(referenceFrom(reference, reference.rule.target, text, filePath));
    }
  }
}

function scanSource(found, dsl, raw, origin, filePath, text) {
  for (const rule of dsl.references) {
    if (rule.where === 'within') pushWithin(found, rule, raw, origin, filePath, text);
  }
  pushPlaceholders(found, dsl, raw, origin, filePath, text);
}

function valueOffset(raw) {
  return raw.startsWith('"') || raw.startsWith("'") ? 1 : 0;
}

function collectInKeys(node, dsl, filePath, text, found) {
  if (!node) return;
  if (node.kind === 'map') {
    for (const entry of node.entries) {
      if (typeof entry.key === 'string' && entry.keyStart != null) {
        scanSource(found, dsl, text.slice(entry.keyStart, entry.keyEnd), entry.keyStart, filePath, text);
      }
      collectInKeys(entry.value, dsl, filePath, text, found);
    }
    return;
  }
  if (node.kind === 'seq') {
    for (const item of node.items) collectInKeys(item, dsl, filePath, text, found);
  }
}

function collectReferences(tree, dsl, filePath, text) {
  const found = { references: [], placeholders: [] };
  walkScalars(tree, (scalar) => {
    if (typeof scalar.value !== 'string') return;
    const raw = text.slice(scalar.start, scalar.end);
    const whole = matchWholeReference(scalar.value, dsl.references, scalar.start + valueOffset(raw));
    if (whole) {
      found.references.push({ ...referenceFrom(whole, whole.rule.target, text, filePath), range: scalar.range });
    }
    scanSource(found, dsl, raw, scalar.start, filePath, text);
  });
  collectInKeys(tree, dsl, filePath, text, found);
  return found;
}

module.exports = { collectSymbols, collectReferences, spell };

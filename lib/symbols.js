const { rangeBetween } = require('./range');

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

function symbolName(key, name) {
  let raw = key;
  if (name.token === 'last') {
    const parts = key.split(/\s+/).filter(Boolean);
    raw = parts.length ? parts[parts.length - 1] : key;
  }
  if (name.spelling === 'snake') raw = raw.replaceAll('-', '_');
  return raw;
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

function pushWithin(refs, rule, value, raw, origin, filePath, text) {
  const re = new RegExp(rule.pattern, 'g');
  for (const match of String(value).matchAll(re)) {
    let body = match[0];
    let trim = 0;
    if (body.startsWith('${') && body.endsWith('}')) {
      trim = 2;
      body = body.slice(2, -1);
    }
    const at = raw.indexOf(match[0]);
    const start = origin + (at >= 0 ? at + trim : 0);
    refs.push({
      target: rule.target,
      groups: match.groups || {},
      range: rangeBetween(text, start, start + body.length),
      file: filePath,
    });
  }
}

function collectInKeys(node, rules, filePath, text, refs) {
  if (!node) return;
  if (node.kind === 'map') {
    for (const entry of node.entries) {
      if (typeof entry.key === 'string' && entry.keyStart != null) {
        const raw = text.slice(entry.keyStart, entry.keyEnd);
        for (const rule of rules) {
          if (rule.where === 'within') pushWithin(refs, rule, raw, raw, entry.keyStart, filePath, text);
        }
      }
      collectInKeys(entry.value, rules, filePath, text, refs);
    }
    return;
  }
  if (node.kind === 'seq') {
    for (const item of node.items) collectInKeys(item, rules, filePath, text, refs);
  }
}

function collectReferences(tree, rules, filePath, text) {
  const refs = [];
  walkScalars(tree, (scalar) => {
    if (typeof scalar.value !== 'string') return;
    for (const rule of rules) {
      if (rule.where === 'whole') {
        const match = scalar.value.match(new RegExp(rule.pattern));
        if (!match || match.index !== 0) continue;
        refs.push({
          target: rule.target,
          groups: match.groups || {},
          range: scalar.range,
          file: filePath,
        });
      } else {
        const raw = text.slice(scalar.start, scalar.end);
        pushWithin(refs, rule, scalar.value, raw, scalar.start, filePath, text);
      }
    }
  });
  collectInKeys(tree, rules, filePath, text, refs);
  return refs;
}

module.exports = { collectSymbols, collectReferences };

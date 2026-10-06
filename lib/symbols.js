const { rangeBetween } = require('./range');
const { matchWholeReference, scanPlaceholders } = require('./placeholder-scan');
const { metaArgumentValues } = require('./meta-arguments');
const { parseFunctionKey } = require('./function-calls');

function spell(text, spelling) {
  return spelling === 'snake' ? text.replaceAll('-', '_') : text;
}

function keyToken(key, token) {
  const parts = key.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || token === 'whole') return key;
  return token === 'first' ? parts[0] : parts[parts.length - 1];
}

function scopeOf(rule, trail) {
  if (rule.scope.literal) return rule.scope.literal;
  const enclosing = [...trail].reverse().find((step) => typeof step === 'string');
  return enclosing === undefined ? null : enclosing;
}

function declaredNames(entry, rule, text) {
  if (rule.name.from === 'key') {
    return [{ name: spell(keyToken(entry.key, rule.name.token), rule.name.spelling), range: entry.keyRange }];
  }
  if (rule.name.from === 'any') return [{ name: null, range: entry.keyRange }];
  if (rule.name.from === 'value') {
    const value = entry.value;
    if (!value || value.kind !== 'scalar' || typeof value.value !== 'string') return [];
    return [{ name: value.value, range: value.range }];
  }
  return metaArgumentValues(entry.key, rule.name.argument).map((argument) => ({
    name: argument.value,
    range: rangeBetween(text, entry.keyStart + argument.start, entry.keyStart + argument.end),
  }));
}

function emit(entry, trail, documentPath, rule, context) {
  if (entry.key == null && rule.name.from !== 'value') return;
  const scope = scopeOf(rule, trail);
  if (scope === null) return;
  const value = entry.value;
  for (const declared of declaredNames(entry, rule, context.text)) {
    context.symbols.push({
      scope,
      name: declared.name,
      everyName: rule.name.from === 'any',
      spelling: rule.name.spelling,
      visibility: rule.scope.visibleFrom || null,
      scopeFromParent: Boolean(rule.scope.fromParent),
      call: parseFunctionKey(entry.key, context.functions) !== null,
      file: context.filePath,
      keyRange: declared.range,
      documentPath,
      valueText: value ? context.text.slice(value.start, value.end) : '',
      valueIsScalar: Boolean(value) && value.kind === 'scalar',
    });
  }
}

function walk(node, tokens, trail, documentPath, rule, context) {
  if (!node || tokens.length === 0) return;
  const [token, ...rest] = tokens;
  if (token.kind === 'key') {
    if (node.kind !== 'map') return;
    const entry = node.entries.find((item) => item.key === token.key);
    if (!entry) return;
    const entryPath = [...documentPath, entry.key];
    if (rest.length === 0) emit(entry, trail, entryPath, rule, context);
    else walk(entry.value, rest, [...trail, entry.key], entryPath, rule, context);
    return;
  }
  if (token.kind === 'star') {
    if (node.kind !== 'map') return;
    for (const entry of node.entries) {
      if (entry.key == null) continue;
      const entryPath = [...documentPath, entry.key];
      if (rest.length === 0) {
        if (!rule.exclude.includes(entry.key)) emit(entry, trail, entryPath, rule, context);
      } else if (!rule.skip.includes(entry.key)) {
        walk(entry.value, rest, [...trail, entry.key], entryPath, rule, context);
      }
    }
    return;
  }
  if (node.kind !== 'seq') return;
  node.items.forEach((item, index) => {
    const itemPath = [...documentPath, index];
    if (rest.length === 0) emit({ key: null, value: item }, trail, itemPath, rule, context);
    else walk(item, rest, trail, itemPath, rule, context);
  });
}

function collectSymbols(tree, dsl, filePath, text) {
  const context = { symbols: [], filePath, text, functions: dsl.functions || null };
  for (const rule of dsl.symbols || []) walk(tree, rule.tokens, [], [], rule, context);
  return context.symbols;
}

function walkSources(node, documentPath, visit) {
  if (!node) return;
  if (node.kind === 'scalar') {
    visit({ node, documentPath, isKey: false });
    return;
  }
  if (node.kind === 'map') {
    for (const entry of node.entries) {
      const entryPath = [...documentPath, entry.key];
      if (typeof entry.key === 'string' && entry.keyStart != null) {
        visit({ node: entry, documentPath: entryPath, isKey: true });
      }
      walkSources(entry.value, entryPath, visit);
    }
    return;
  }
  if (node.kind === 'seq') node.items.forEach((item, index) => walkSources(item, [...documentPath, index], visit));
}

function referenceFrom(match, context, details) {
  return {
    target: match.rule.target,
    rule: match.rule,
    groups: match.groups,
    range: rangeBetween(context.text, match.span.start, match.span.end),
    span: match.span,
    file: context.filePath,
    ...details,
  };
}

function positionProblem(rule, position) {
  if (rule.where.includes(position)) return null;
  return `a reference matching ${rule.pattern} is not allowed as ${position.replaceAll('_', ' ')}`;
}

function pushWithin(found, rule, raw, origin, documentPath, context) {
  for (const match of raw.matchAll(new RegExp(rule.pattern, 'gd'))) {
    if (match[0].length === 0) continue;
    const start = origin + match.index;
    const groups = [];
    for (const [group, span] of Object.entries((match.indices && match.indices.groups) || {})) {
      if (span) groups.push({ group, start: origin + span[0], end: origin + span[1] });
    }
    const span = { start, end: start + match[0].length, groups };
    found.references.push(referenceFrom({ rule, groups: match.groups || {}, span }, context, {
      documentPath,
      position: 'within',
    }));
  }
}

function pushPlaceholders(found, raw, origin, documentPath, context) {
  for (const placeholder of scanPlaceholders(raw, context.dsl.placeholders, context.dsl.references, origin)) {
    const range = rangeBetween(context.text, placeholder.start, placeholder.end);
    const { reference } = placeholder;
    let problem = null;
    if (!reference) problem = `unknown placeholder ${placeholder.text}`;
    else if (reference.rule.trailingText === 'none' && reference.trailingText !== '') {
      problem = `unexpected text after the reference in ${placeholder.text}`;
    } else problem = positionProblem(reference.rule, placeholder.position);
    found.placeholders.push({ ...placeholder, range, valid: problem === null });
    if (problem) {
      found.problems.push({ range, message: problem });
      continue;
    }
    found.references.push({
      ...referenceFrom(reference, context, { documentPath, position: placeholder.position }),
      range: rangeBetween(context.text, placeholder.bodyStart, placeholder.bodyEnd),
    });
  }
}

function valueOffset(raw) {
  return raw.startsWith('"') || raw.startsWith("'") ? 1 : 0;
}

function scanSource(source, found, context) {
  const { node, documentPath, isKey } = source;
  const start = isKey ? node.keyStart : node.start;
  const end = isKey ? node.keyEnd : node.end;
  const raw = context.text.slice(start, end);
  const wholeRules = context.dsl.references.filter((rule) => rule.where.includes('whole'));
  if (!isKey && typeof node.value === 'string') {
    const whole = matchWholeReference(node.value, wholeRules, start + valueOffset(raw));
    if (whole && (whole.rule.trailingText === 'any' || whole.trailingText === '')) {
      found.references.push({
        ...referenceFrom(whole, context, { documentPath, position: 'whole' }),
        range: node.range,
      });
    } else if (whole) {
      found.problems.push({ range: node.range, message: 'unexpected text after the reference' });
    }
  }
  for (const rule of context.dsl.references) {
    if (rule.where.includes('within')) pushWithin(found, rule, raw, start, documentPath, context);
  }
  pushPlaceholders(found, raw, start, documentPath, context);
}

function collectReferences(tree, dsl, filePath, text) {
  const found = { references: [], placeholders: [], problems: [] };
  const context = { dsl, filePath, text };
  walkSources(tree, [], (source) => {
    if (!source.isKey && typeof source.node.value !== 'string') return;
    scanSource(source, found, context);
  });
  return found;
}

module.exports = { collectSymbols, collectReferences, spell };

const { rangeBetween } = require('./range');
const { matchWholeReferences, readsAt, scanPlaceholders } = require('./placeholder-scan');
const { metaArgumentValues } = require('./meta-arguments');
const { parseFunctionKey } = require('./function-calls');
const { PATH_STEP_KINDS, pathMatches } = require('./document-path');
const { WHOLE_SCALAR, ANYWHERE_IN_SCALAR } = require('./reference-positions');

function spell(text, nameSpelling) {
  return nameSpelling === 'dashes_as_underscores' ? text.replaceAll('-', '_') : text;
}

function keyWords(key, keyToken) {
  const words = key.split(/\s+/).filter(Boolean);
  if (words.length === 0 || keyToken === 'all_words') return key;
  return keyToken === 'first_word' ? words[0] : words[words.length - 1];
}

function scopeOf(rule, trail, scopes) {
  const declared = scopes[rule.scopeName];
  if (!declared || !declared.namedByParentKey) return rule.scopeName;
  const enclosing = [...trail].reverse().find((step) => typeof step === 'string');
  return enclosing === undefined ? null : enclosing;
}

function declaredNames(entry, rule, text) {
  if (rule.declaresEveryName) return [{ name: null, range: entry.keyRange }];
  if (rule.nameSource === 'key') {
    return [{ name: spell(keyWords(entry.key, rule.keyToken), rule.nameSpelling), range: entry.keyRange }];
  }
  if (rule.nameSource === 'value') {
    const value = entry.value;
    if (!value || value.kind !== 'scalar' || typeof value.value !== 'string') return [];
    return [{ name: spell(value.value, rule.nameSpelling), range: value.range }];
  }
  return metaArgumentValues(entry.key, rule.metaArgumentName).map((argument) => ({
    name: argument.value,
    range: rangeBetween(text, entry.keyStart + argument.start, entry.keyStart + argument.end),
  }));
}

function emit(entry, trail, documentPath, rule, context) {
  if (entry.key == null && rule.nameSource !== 'value') return;
  const scope = scopeOf(rule, trail, context.scopes);
  if (scope === null) return;
  const value = entry.value;
  for (const declared of declaredNames(entry, rule, context.text)) {
    context.symbols.push({
      scope,
      scopeName: rule.scopeName,
      name: declared.name,
      everyName: rule.declaresEveryName,
      nameSpelling: rule.nameSpelling,
      call: parseFunctionKey(entry.key, context.markerFunction) !== null,
      file: context.filePath,
      keyRange: declared.range,
      documentPath,
      valueText: value ? context.text.slice(value.start, value.end) : '',
      valueIsScalar: Boolean(value) && value.kind === 'scalar',
    });
  }
}

function childrenOf(node) {
  if (node.kind === 'map') {
    return node.entries
      .filter((entry) => entry.key != null)
      .map((entry) => ({ entry, step: entry.key, trailSteps: [entry.key] }));
  }
  if (node.kind === 'seq') {
    return node.items.map((item, index) => ({ entry: { key: null, value: item }, step: index, trailSteps: [] }));
  }
  return [];
}

function walk(node, tokens, trail, documentPath, rule, context) {
  if (!node || tokens.length === 0) return;
  const [token, ...rest] = tokens;
  if (token.kind === PATH_STEP_KINDS.name) {
    if (node.kind !== 'map') return;
    const entry = node.entries.find((item) => item.key === token.key);
    if (!entry) return;
    const entryPath = [...documentPath, entry.key];
    if (rest.length === 0) emit(entry, trail, entryPath, rule, context);
    else walk(entry.value, rest, [...trail, entry.key], entryPath, rule, context);
    return;
  }
  const descending = token.kind === PATH_STEP_KINDS.descendants;
  for (const child of childrenOf(node)) {
    const childPath = [...documentPath, child.step];
    const childTrail = [...trail, ...child.trailSteps];
    const skipped = typeof child.step === 'string' && rule.skipKeys.includes(child.step);
    const excluded = typeof child.step === 'string' && rule.excludeCandidates.includes(child.step);
    if ((rest.length === 0 || descending) && !excluded) emit(child.entry, trail, childPath, rule, context);
    if (skipped) continue;
    if (descending) walk(child.entry.value, tokens, childTrail, childPath, rule, context);
    else if (rest.length > 0) walk(child.entry.value, rest, childTrail, childPath, rule, context);
  }
}

function collectSymbols(tree, dsl, filePath, text) {
  const context = {
    symbols: [],
    filePath,
    text,
    markerFunction: dsl.function ? dsl.function.markerFunction : null,
    scopes: dsl.scopes || {},
  };
  for (const rule of dsl.declarations || []) walk(tree, rule.tokens, [], [], rule, context);
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
    rule: match.rule,
    groups: match.groups,
    range: rangeBetween(context.text, match.span.start, match.span.end),
    span: match.span,
    file: context.filePath,
    ...details,
  };
}

function positionProblem(rule, position) {
  if (rule.positions.includes(position)) return null;
  return `a reference matching ${rule.pattern} is not allowed as ${position}`;
}

function pushWithin(found, rule, raw, origin, location, context) {
  for (const match of raw.matchAll(new RegExp(rule.pattern, 'gd'))) {
    if (match[0].length === 0) continue;
    const start = origin + match.index;
    const groups = [];
    for (const [group, span] of Object.entries((match.indices && match.indices.groups) || {})) {
      if (span) groups.push({ group, start: origin + span[0], end: origin + span[1] });
    }
    const span = { start, end: start + match[0].length, groups };
    found.references.push(referenceFrom({ rule, groups: match.groups || {}, span }, context, {
      ...location,
      position: ANYWHERE_IN_SCALAR,
    }));
  }
}

function placeholdersRead(documentPath, placeholder) {
  if (!placeholder) return false;
  return !placeholder.unscannedPaths.some((entry) => pathMatches(entry.tokens, documentPath, entry));
}

function pushPlaceholders(found, raw, origin, location, context) {
  if (!placeholdersRead(location.documentPath, context.dsl.placeholder)) return;
  for (const placeholder of scanPlaceholders(raw, context.dsl.placeholder, context.dsl.references, origin)) {
    const range = rangeBetween(context.text, placeholder.start, placeholder.end);
    const { reference } = placeholder;
    let problem = null;
    if (!reference) problem = `unknown placeholder ${placeholder.text}`;
    else if (!reference.rule.textAfterNameAllowed && reference.trailingText !== '') {
      problem = `unexpected text after the reference in ${placeholder.text}`;
    } else problem = positionProblem(reference.rule, placeholder.position);
    found.placeholders.push({ ...placeholder, range, valid: problem === null });
    if (problem) {
      found.problems.push({ range, message: problem });
      continue;
    }
    found.references.push({
      ...referenceFrom(reference, context, { ...location, position: placeholder.position }),
      range: rangeBetween(context.text, placeholder.bodyStart, placeholder.bodyEnd),
      alternatives: placeholder.readings.map(({ rule, groups }) => ({ rule, groups })),
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
  const location = { documentPath, inKey: isKey };
  const wholeRules = context.dsl.references.filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  if (!isKey && typeof node.value === 'string') {
    const readings = matchWholeReferences(node.value, wholeRules, start + valueOffset(raw));
    const fitting = readings.filter((reading) => readsAt(reading, WHOLE_SCALAR));
    if (fitting.length > 0) {
      found.references.push({
        ...referenceFrom(fitting[0], context, { ...location, position: WHOLE_SCALAR }),
        range: node.range,
        alternatives: fitting.map(({ rule, groups }) => ({ rule, groups })),
      });
    } else if (readings.length > 0) {
      found.problems.push({ range: node.range, message: 'unexpected text after the reference' });
    }
  }
  for (const rule of context.dsl.references) {
    if (rule.positions.includes(ANYWHERE_IN_SCALAR)) pushWithin(found, rule, raw, start, location, context);
  }
  pushPlaceholders(found, raw, start, location, context);
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

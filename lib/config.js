const YAML = require('yaml');
const { matchAny } = require('./glob');
const { parseAt } = require('./document-path');

const REFERENCE_POSITIONS = ['whole', 'placeholder', 'placeholder_in_string', 'within'];
const TRAILING_TEXT = ['none', 'any'];
const NAME_SOURCES = ['key', 'value', 'meta_argument'];
const NAME_TOKENS = ['whole', 'first', 'last'];
const NAME_SPELLINGS = ['as_written', 'snake'];
const UNNAMED_CALLS = ['sole_key', 'refused'];
const VISIBILITY_WORDS = ['stack', 'everywhere', 'following'];

function isMapping(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function compiles(pattern) {
  try {
    RegExp(pattern);
    return typeof pattern === 'string';
  } catch {
    return false;
  }
}

function createReport(configProblems, where) {
  return {
    where,
    problem(message) {
      configProblems.push(`${where}${message}`);
    },
    at(suffix) {
      return createReport(configProblems, `${where}${suffix}`);
    },
  };
}

function requiredOneOf(raw, field, allowed, report) {
  if (allowed.includes(raw[field])) return raw[field];
  if (raw[field] === undefined) report.problem(`.${field} is required: one of ${allowed.join(', ')}`);
  else report.problem(`.${field} must be one of ${allowed.join(', ')}`);
  return null;
}

function requiredList(raw, field, report) {
  if (Array.isArray(raw[field])) return strings(raw[field]);
  report.problem(`.${field} is required: a list, [] when empty`);
  return null;
}

function normalizeName(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' is required: a mapping with from');
    return null;
  }
  const from = requiredOneOf(raw, 'from', NAME_SOURCES, report);
  if (from === 'key') {
    const token = requiredOneOf(raw, 'token', NAME_TOKENS, report);
    const spelling = requiredOneOf(raw, 'spelling', NAME_SPELLINGS, report);
    return token && spelling ? { from, token, spelling } : null;
  }
  if (from === 'meta_argument') {
    if (typeof raw.argument !== 'string' || raw.argument === '') {
      report.problem('.argument is required: the meta argument that holds the name');
      return null;
    }
    return { from, argument: raw.argument, spelling: 'as_written' };
  }
  return from ? { from, spelling: 'as_written' } : null;
}

function normalizeSymbolScope(raw, report) {
  if (typeof raw === 'string' && raw !== '') return { literal: raw };
  if (isMapping(raw) && raw.from === 'parent') {
    const visibleFrom = normalizeVisibility(raw.visible_from, report);
    return visibleFrom ? { fromParent: true, visibleFrom } : null;
  }
  report.problem(' is required: a scope name, or { from: parent, visible_from }');
  return null;
}

function legacySymbol(raw, report) {
  report.problem(': kind and qualify are deprecated: write scope');
  const qualify = isMapping(raw.qualify) ? raw.qualify : {};
  const name = isMapping(raw.name) ? raw.name : {};
  return {
    at: raw.at,
    tokens: parseAt(raw.at),
    skip: strings(raw.skip),
    exclude: strings(raw.exclude),
    name: {
      from: 'key',
      token: name.token === 'first' || name.token === 'last' ? name.token : 'whole',
      spelling: name.spelling === 'snake' ? 'snake' : 'as_written',
    },
    scope: qualify.type === 'parent' ? { fromParent: true, visibleFrom: { kind: 'stack' } } : { literal: raw.kind },
  };
}

function normalizeSymbol(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping');
    return null;
  }
  if (raw.kind !== undefined || raw.qualify !== undefined) return legacySymbol(raw, report);
  const tokens = parseAt(raw.at);
  if (!tokens) report.problem('.at is required: a path such as $.locals.*');
  const skip = requiredList(raw, 'skip', report);
  const exclude = requiredList(raw, 'exclude', report);
  const name = normalizeName(raw.name, report.at('.name'));
  const scope = normalizeSymbolScope(raw.scope, report.at('.scope'));
  if (!tokens || !skip || !exclude || !name || !scope) return null;
  return { at: raw.at, tokens, skip, exclude, name, scope };
}

function normalizeTargetScope(raw, report) {
  if (typeof raw === 'string' && raw !== '') return { literal: raw };
  if (isMapping(raw) && typeof raw.group === 'string') return { group: raw.group };
  report.problem(' is required: a scope name, or { group: <pattern group> }');
  return null;
}

function legacyReference(raw, report) {
  report.problem(': target.kind and a single where are deprecated: write target.scope and a where list');
  const target = isMapping(raw.target) ? raw.target : {};
  const where = Array.isArray(raw.where) ? strings(raw.where) : [raw.where];
  const scope = typeof target.type === 'string' ? { group: target.type } : { literal: target.kind };
  return {
    pattern: raw.pattern,
    where: where.filter((position) => REFERENCE_POSITIONS.includes(position)),
    trailingText: raw.trailing_text === 'none' ? 'none' : 'any',
    target: { scope, name: typeof target.name === 'string' ? target.name : null },
  };
}

function normalizeReference(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping');
    return null;
  }
  if (!compiles(raw.pattern)) {
    report.problem('.pattern is required: a regular expression');
    return null;
  }
  const target = isMapping(raw.target) ? raw.target : null;
  if ((target && target.kind !== undefined) || typeof raw.where === 'string') return legacyReference(raw, report);
  let where = null;
  if (!Array.isArray(raw.where) || raw.where.length === 0) {
    report.problem(`.where is required: a list from ${REFERENCE_POSITIONS.join(', ')}`);
  } else if (raw.where.some((position) => !REFERENCE_POSITIONS.includes(position))) {
    report.problem(`.where takes ${REFERENCE_POSITIONS.join(', ')}`);
  } else {
    ({ where } = raw);
  }
  const trailingText = requiredOneOf(raw, 'trailing_text', TRAILING_TEXT, report);
  if (!target) report.problem('.target is required: { scope, name }');
  const scope = target ? normalizeTargetScope(target.scope, report.at('.target.scope')) : null;
  if (target && typeof target.name !== 'string') {
    report.problem('.target.name is required: the pattern group holding the name');
  }
  if (!where || !trailingText || !scope || !target || typeof target.name !== 'string') return null;
  return { pattern: raw.pattern, where, trailingText, target: { scope, name: target.name } };
}

function normalizeVisibility(raw, report) {
  if (VISIBILITY_WORDS.includes(raw)) return { kind: raw };
  if (Array.isArray(raw) && raw.length > 0) {
    const paths = raw.map(parseAt);
    if (paths.every(Boolean)) return { kind: 'paths', paths };
  }
  report.problem(`.visible_from is required: ${VISIBILITY_WORDS.join(', ')}, or a list of paths`);
  return null;
}

function normalizeScopes(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' is required: a mapping of scope names');
    return {};
  }
  const scopes = {};
  for (const [scopeName, definition] of Object.entries(raw)) {
    const scopeReport = report.at(`.${scopeName}`);
    if (!isMapping(definition)) {
      scopeReport.problem(' must be a mapping with visible_from');
      continue;
    }
    const visibleFrom = normalizeVisibility(definition.visible_from, scopeReport);
    if (!visibleFrom) continue;
    scopes[scopeName] = { visibleFrom, names: Array.isArray(definition.names) ? strings(definition.names) : null };
  }
  return scopes;
}

function legacyPlaceholderParts(rawPlaceholders, references, scopes, report) {
  const legacyBuiltins = Array.isArray(rawPlaceholders.builtins);
  const legacyReferences = Array.isArray(rawPlaceholders.references);
  if (!legacyBuiltins && !legacyReferences) return;
  report.problem(': builtins and references are deprecated: write a global scope and where lists');
  if (legacyBuiltins) {
    scopes.global = { visibleFrom: { kind: 'everywhere' }, names: strings(rawPlaceholders.builtins) };
    references.push({
      pattern: '^(?<name>[a-z0-9_]+)$',
      where: ['placeholder', 'placeholder_in_string'],
      trailingText: 'none',
      target: { scope: { literal: 'global' }, name: 'name' },
    });
  }
  const concepts = strings(rawPlaceholders.references);
  for (const reference of references) {
    const scopeName = reference.target.scope.literal;
    const inPlaceholders = (scopeName === 'local' && concepts.includes('local'))
      || (scopeName !== 'local' && concepts.includes('ref'));
    if (inPlaceholders && reference.where.includes('whole')) {
      reference.where = [...new Set([...reference.where, 'placeholder', 'placeholder_in_string'])];
    }
  }
}

function normalizePlaceholders(raw, report) {
  if (raw === 'none') return null;
  if (raw === undefined) {
    report.problem(' is required: { pattern }, or none');
    return null;
  }
  if (!isMapping(raw) || !compiles(raw.pattern)) {
    report.problem('.pattern is required: a regular expression');
    return null;
  }
  if (!raw.pattern.includes('(?<body>')) {
    report.problem(".pattern must name the placeholder's body with a (?<body>...) group");
    return null;
  }
  return { pattern: raw.pattern };
}

function vocabularySource(raw) {
  if (raw === 'terraform') return { source: 'terraform' };
  if (isMapping(raw) && typeof raw.schema === 'string' && raw.schema.startsWith('#/')) {
    return { source: 'schema', pointer: raw.schema };
  }
  return null;
}

function normalizeVocabulary(raw, report) {
  const sources = Array.isArray(raw) ? raw.map(vocabularySource) : [];
  if (sources.length > 0 && sources.every(Boolean)) return sources;
  report.problem(' is required: a list of sources, each terraform or { schema: "#/<pointer>" }');
  return null;
}

function normalizeRefusedAt(raw, report) {
  if (!Array.isArray(raw)) {
    report.problem(' is required: a list, [] when empty');
    return null;
  }
  const refused = [];
  raw.forEach((entry, index) => {
    const entryReport = report.at(`[${index}]`);
    const tokens = isMapping(entry) ? parseAt(entry.at) : null;
    if (!tokens) {
      entryReport.problem('.at is required: a path');
      return;
    }
    const skip = requiredList(entry, 'skip', entryReport);
    if (typeof entry.subtree !== 'boolean') entryReport.problem('.subtree is required: true or false');
    if (skip && typeof entry.subtree === 'boolean') refused.push({ tokens, skip, subtree: entry.subtree });
  });
  return refused;
}

function normalizeFunctions(raw, report) {
  if (raw === 'none') return null;
  if (!isMapping(raw)) {
    report.problem(' is required: a functions mapping, or none');
    return null;
  }
  const marker = typeof raw.marker === 'string' && raw.marker !== '' ? raw.marker : null;
  if (!marker) report.problem('.marker is required: the text that opens a call in a key');
  const splat = typeof raw.splat === 'string' && raw.splat !== '' ? raw.splat : null;
  if (!splat) report.problem('.splat is required: the suffix that spreads a list into arguments');
  const vocabulary = normalizeVocabulary(raw.vocabulary, report.at('.vocabulary'));
  const unnamedCalls = requiredOneOf(raw, 'unnamed_calls', UNNAMED_CALLS, report);
  let callResultsWhere = null;
  if (Array.isArray(raw.call_results_where)
    && raw.call_results_where.every((position) => REFERENCE_POSITIONS.includes(position))) {
    callResultsWhere = raw.call_results_where;
  } else {
    report.problem(`.call_results_where is required: a list from ${REFERENCE_POSITIONS.join(', ')}`);
  }
  const refusedAt = normalizeRefusedAt(raw.refused_at, report.at('.refused_at'));
  if (!marker || !splat || !vocabulary || !unnamedCalls || !callResultsWhere || !refusedAt) return null;
  return { marker, splat, vocabulary, unnamedCalls, callResultsWhere, refusedAt };
}

function normalizeLayers(raw, report) {
  if (raw === 'none') return null;
  if (isMapping(raw) && Array.isArray(raw.environments)) return { environments: strings(raw.environments) };
  report.problem(' is required: { environments }, or none');
  return null;
}

function normalizeSchema(raw, report) {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return strings(raw);
  report.problem(' is required: a search path, [] when empty');
  return [];
}

function normalizeDsl(raw, configProblems) {
  if (!isMapping(raw) || typeof raw.id !== 'string') return null;
  const report = createReport(configProblems, raw.id);
  let includes = strings(raw.includes);
  if (raw.match !== undefined) {
    report.problem('.match is deprecated: write includes');
    if (includes.length === 0) includes = strings(raw.match);
  } else if (!Array.isArray(raw.includes)) {
    report.problem('.includes is required: a list of globs');
  }
  const excludes = requiredList(raw, 'excludes', report) || [];
  const scopes = raw.scopes === undefined && hasLegacyRules(raw)
    ? {}
    : normalizeScopes(raw.scopes, report.at('.scopes'));
  const symbols = Array.isArray(raw.symbols)
    ? raw.symbols.map((rule, index) => normalizeSymbol(rule, report.at(`.symbols[${index}]`))).filter(Boolean)
    : [];
  if (!Array.isArray(raw.symbols)) report.problem('.symbols is required: a list, [] when empty');
  const references = Array.isArray(raw.references)
    ? raw.references.map((rule, index) => normalizeReference(rule, report.at(`.references[${index}]`))).filter(Boolean)
    : [];
  if (!Array.isArray(raw.references)) report.problem('.references is required: a list, [] when empty');
  const placeholders = normalizePlaceholders(raw.placeholders, report.at('.placeholders'));
  if (isMapping(raw.placeholders)) {
    legacyPlaceholderParts(raw.placeholders, references, scopes, report.at('.placeholders'));
  }
  for (const reference of references) {
    const scopeName = reference.target.scope.literal;
    if (scopeName && !scopes[scopeName] && !hasLegacyRules(raw)) {
      report.problem(`: scope ${scopeName} is not declared in scopes`);
    }
  }
  for (const symbol of symbols) {
    if (symbol.scope.literal && !scopes[symbol.scope.literal]) {
      if (hasLegacyRules(raw)) scopes[symbol.scope.literal] = { visibleFrom: { kind: 'stack' }, names: null };
      else report.problem(`: scope ${symbol.scope.literal} is not declared in scopes`);
    }
  }
  return {
    id: raw.id,
    includes,
    excludes,
    schema: normalizeSchema(raw.schema, report.at('.schema')),
    layers: normalizeLayers(raw.layers, report.at('.layers')),
    placeholders,
    functions: normalizeFunctions(raw.functions, report.at('.functions')),
    scopes,
    symbols,
    references,
  };
}

function hasLegacyRules(raw) {
  const symbols = Array.isArray(raw.symbols) ? raw.symbols : [];
  return symbols.some((rule) => isMapping(rule) && (rule.kind !== undefined || rule.qualify !== undefined));
}

function parseConfig(text) {
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    return { ok: false, error: err.message, dsls: [] };
  }
  if (!isMapping(parsed)) {
    return { ok: false, error: 'yaml-dsl.yml must be a mapping', dsls: [] };
  }
  const configProblems = [];
  const dsls = Array.isArray(parsed.dsls)
    ? parsed.dsls.map((raw) => normalizeDsl(raw, configProblems)).filter(Boolean)
    : [];
  if (configProblems.length) return { ok: false, error: configProblems.join('; '), dsls };
  return { ok: true, error: null, dsls };
}

function insideDir(filePath, dir) {
  const file = String(filePath).replaceAll('\\', '/');
  const root = String(dir).replaceAll('\\', '/').replace(/\/$/, '');
  if (!root) return false;
  return file === root || file.startsWith(`${root}/`);
}

function ownsFile(dsl, filePath) {
  return matchAny(dsl.includes, filePath) && !matchAny(dsl.excludes, filePath);
}

function claimFile(filePath, dsls) {
  // A DSL owns files under its own yaml-dsl.yml. Another workspace folder's
  // copy of the same id must not claim this file.
  const hits = dsls.filter((dsl) => {
    if (dsl.dir && !insideDir(filePath, dsl.dir)) return false;
    return ownsFile(dsl, filePath);
  });
  if (hits.length === 0) return { status: 'none' };
  if (hits.length > 1) return { status: 'many', ids: hits.map((dsl) => dsl.id) };
  return { status: 'one', dsl: hits[0] };
}

module.exports = { parseConfig, claimFile, ownsFile, REFERENCE_POSITIONS };

const YAML = require('yaml');
const { matchAny } = require('./glob');
const { PLACEHOLDER_REFERENCES } = require('./placeholder-scan');

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function normalizeName(name) {
  const source = name && typeof name === 'object' && !Array.isArray(name) ? name : {};
  return {
    token: source.token === 'first' || source.token === 'last' ? source.token : null,
    spelling: source.spelling === 'snake' ? 'snake' : null,
  };
}

function normalizeQualify(qualify) {
  if (!qualify || typeof qualify !== 'object' || Array.isArray(qualify)) return {};
  const out = {};
  for (const [key, value] of Object.entries(qualify)) {
    if (value === 'parent') out[key] = 'parent';
  }
  return out;
}

function normalizeSymbol(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || typeof raw.at !== 'string') return null;
  return {
    kind: raw.kind,
    at: raw.at,
    skip: strings(raw.skip),
    exclude: strings(raw.exclude),
    name: normalizeName(raw.name),
    qualify: normalizeQualify(raw.qualify),
  };
}

function normalizeReference(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.pattern !== 'string') return null;
  if (raw.where !== 'whole' && raw.where !== 'within') return null;
  if (!raw.target || typeof raw.target !== 'object' || typeof raw.target.kind !== 'string') return null;
  try {
    RegExp(raw.pattern);
  } catch {
    return null;
  }
  const target = { kind: raw.target.kind };
  for (const [key, value] of Object.entries(raw.target)) {
    if (key === 'kind') continue;
    if (typeof value === 'string') target[key] = value;
  }
  return { pattern: raw.pattern, where: raw.where, target };
}

function normalizePlaceholders(raw, where, configProblems) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    configProblems.push(`${where} must be a mapping`);
    return null;
  }
  if (typeof raw.pattern !== 'string') {
    configProblems.push(`${where}.pattern must be a regular expression`);
    return null;
  }
  try {
    RegExp(raw.pattern);
  } catch {
    configProblems.push(`${where}.pattern must be a regular expression`);
    return null;
  }
  if (!raw.pattern.includes('(?<body>')) {
    configProblems.push(`${where}.pattern must name the placeholder's body with a (?<body>...) group`);
    return null;
  }
  const references = strings(raw.references);
  const unknownReferences = references.filter((concept) => !PLACEHOLDER_REFERENCES.includes(concept));
  if (unknownReferences.length) {
    const accepted = PLACEHOLDER_REFERENCES.join(' and ');
    configProblems.push(`${where}.references takes ${accepted}: ${unknownReferences.join(', ')}`);
  }
  return {
    pattern: raw.pattern,
    builtins: strings(raw.builtins),
    references: references.filter((concept) => PLACEHOLDER_REFERENCES.includes(concept)),
  };
}

function schemaSearch(value) {
  if (typeof value === 'string') return [value];
  return strings(value);
}

function normalizeDsl(raw, configProblems) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const environments = raw.layers && Array.isArray(raw.layers.environments)
    ? raw.layers.environments.filter((item) => typeof item === 'string')
    : null;
  const includes = strings(raw.includes);
  if (raw.match !== undefined) configProblems.push(`${raw.id}.match is deprecated: write includes`);
  return {
    id: raw.id,
    includes: includes.length ? includes : strings(raw.match),
    excludes: strings(raw.excludes),
    schema: schemaSearch(raw.schema),
    layers: environments ? { environments } : null,
    placeholders: normalizePlaceholders(raw.placeholders, `${raw.id}.placeholders`, configProblems),
    symbols: Array.isArray(raw.symbols) ? raw.symbols.map(normalizeSymbol).filter(Boolean) : [],
    references: Array.isArray(raw.references) ? raw.references.map(normalizeReference).filter(Boolean) : [],
  };
}

function parseConfig(text) {
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    return { ok: false, error: err.message, dsls: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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

module.exports = { parseConfig, claimFile, ownsFile };

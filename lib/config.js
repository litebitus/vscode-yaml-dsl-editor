const YAML = require('yaml');
const { matchAny } = require('./glob');

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function normalizeName(name) {
  const source = name && typeof name === 'object' && !Array.isArray(name) ? name : {};
  return {
    token: source.token === 'last' ? 'last' : null,
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

function schemaSearch(value) {
  if (typeof value === 'string') return [value];
  return strings(value);
}

function normalizeDsl(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const environments = raw.layers && Array.isArray(raw.layers.environments)
    ? raw.layers.environments.filter((item) => typeof item === 'string')
    : null;
  return {
    id: raw.id,
    match: strings(raw.match),
    schema: schemaSearch(raw.schema),
    layers: environments ? { environments } : null,
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
  const dsls = Array.isArray(parsed.dsls) ? parsed.dsls.map(normalizeDsl).filter(Boolean) : [];
  return { ok: true, error: null, dsls };
}

function claimFile(filePath, dsls) {
  const hits = dsls.filter((dsl) => matchAny(dsl.match, filePath));
  if (hits.length === 0) return { status: 'none' };
  if (hits.length > 1) return { status: 'many', ids: hits.map((dsl) => dsl.id) };
  return { status: 'one', dsl: hits[0] };
}

module.exports = { parseConfig, claimFile };

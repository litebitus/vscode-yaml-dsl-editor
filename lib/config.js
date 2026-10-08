const YAML = require('yaml');
const { matchAny } = require('./glob');
const { parseAt } = require('./document-path');
const { REFERENCE_POSITIONS } = require('./reference-positions');

const COMMON_LAYER_DISCOVERIES = ['parent', 'ancestor'];
const KEY_SORT_ORDERS = ['alphabetical', 'significance'];
const FUNCTION_DEFINITIONS = ['terraform', 'schema'];
const NAME_SOURCES = ['key', 'value', 'meta_argument'];
const KEY_TOKENS = ['all_words', 'first_word', 'last_word'];
const NAME_SPELLINGS = ['as_written', 'dashes_as_underscores'];
const LOGICAL_SCOPE_NAME = /^[A-Z][A-Z0-9_]*$/;

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

function requiredList(raw, field, report) {
  if (Array.isArray(raw[field])) return strings(raw[field]);
  report.problem(`.${field} is required: a list, [] when empty`);
  return null;
}

function requiredText(raw, field, description, report) {
  if (typeof raw[field] === 'string' && raw[field] !== '') return raw[field];
  report.problem(`.${field} is required: ${description}`);
  return null;
}

function requiredBoolean(raw, field, report) {
  if (typeof raw[field] === 'boolean') return raw[field];
  report.problem(`.${field} is required: true or false`);
  return null;
}

function requiredOneOf(raw, field, allowed, report) {
  if (allowed.includes(raw[field])) return raw[field];
  report.problem(`.${field} is required: one of ${allowed.join(', ')}`);
  return null;
}

function nullableOneOf(raw, field, allowed, report) {
  if (raw[field] === null || allowed.includes(raw[field])) return raw[field];
  report.problem(`.${field} is required: one of ${allowed.join(', ')}, or null`);
  return undefined;
}

function nullableText(raw, field, description, report) {
  if (raw[field] === null || (typeof raw[field] === 'string' && raw[field] !== '')) return raw[field];
  report.problem(`.${field} is required: ${description}, or null`);
  return undefined;
}

function requiredPositions(raw, field, report) {
  const listed = raw[field];
  if (Array.isArray(listed) && listed.every((position) => REFERENCE_POSITIONS.includes(position))) return listed;
  report.problem(`.${field} is required: a list from ${REFERENCE_POSITIONS.join(', ')}`);
  return null;
}

function requiredPaths(raw, field, report) {
  const listed = raw[field];
  const tokens = Array.isArray(listed) ? listed.map(parseAt) : [];
  if (Array.isArray(listed) && tokens.every(Boolean)) return tokens;
  report.problem(`.${field} is required: a list of JSONPaths such as $.cases`);
  return null;
}

function normalizePathEntries(raw, field, report, readMoreFields = () => ({}), includesSubtreeAccepted = true) {
  if (!Array.isArray(raw[field])) {
    report.problem(`.${field} is required: a list, [] when empty`);
    return null;
  }
  const entries = [];
  raw[field].forEach((entry, index) => {
    const entryReport = report.at(`.${field}[${index}]`);
    if (!isMapping(entry)) {
      entryReport.problem(' must be a mapping with path and skip_keys');
      return;
    }
    const tokens = parseAt(entry.path);
    if (!tokens) entryReport.problem('.path is required: a JSONPath such as $.build or $.build..*');
    const skipKeys = requiredList(entry, 'skip_keys', entryReport);
    const includesSubtreeStated = Object.hasOwn(entry, 'includes_subtree');
    if (includesSubtreeStated && !includesSubtreeAccepted) {
      entryReport.problem('.includes_subtree is not read here: list the path ending in ..* as its own entry');
      return;
    }
    const includesSubtree = includesSubtreeStated ? requiredBoolean(entry, 'includes_subtree', entryReport) : false;
    const moreFields = readMoreFields(entry, entryReport);
    if (tokens && entries.some((listed) => listed.path === entry.path)) {
      entryReport.problem(`.path ${entry.path} is listed more than once in ${field}`);
      return;
    }
    if (tokens && skipKeys && includesSubtree !== null && moreFields) {
      entries.push({ path: entry.path, tokens, skipKeys, includesSubtree, ...moreFields });
    }
  });
  return entries;
}

function requiredDistinctKeys(raw, field, report) {
  const keys = requiredList(raw, field, report);
  if (!keys) return null;
  if (keys.length !== raw[field].length || keys.some((key) => key === '')) {
    report.problem(`.${field} is required: a list of keys, [] when empty`);
    return null;
  }
  if (new Set(keys).size !== keys.length) {
    report.problem(`.${field} lists a key more than once`);
    return null;
  }
  return keys;
}

function normalizeKeySortOrders(raw, report) {
  return normalizePathEntries(raw, 'key_sort_orders', report, (entry, entryReport) => {
    const order = requiredOneOf(entry, 'order', KEY_SORT_ORDERS, entryReport);
    const firstKeys = requiredDistinctKeys(entry, 'first_keys', entryReport);
    const lastKeys = requiredDistinctKeys(entry, 'last_keys', entryReport);
    if (!order || !firstKeys || !lastKeys) return null;
    if (order === 'alphabetical' && (firstKeys.length > 0 || lastKeys.length > 0)) {
      entryReport.problem(' lists first_keys or last_keys under alphabetical order; both are [] there');
      return null;
    }
    const inBoth = firstKeys.filter((key) => lastKeys.includes(key));
    if (inBoth.length > 0) {
      entryReport.problem(` lists ${inBoth.join(', ')} in both first_keys and last_keys`);
      return null;
    }
    return { order, firstKeys, lastKeys };
  }, false) || [];
}

function isDepth(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeKeyDepths(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' is required: a mapping of keys to whole numbers from 1, {} when empty');
    return null;
  }
  const unread = Object.keys(raw).filter((key) => !isDepth(raw[key]));
  for (const key of unread) report.problem(`.${key} must be a whole number from 1`);
  return unread.length === 0 ? { ...raw } : null;
}

function normalizeDuplicateCheck(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' is required: a mapping with depth, key_depths and skip_keys');
    return null;
  }
  const depth = isDepth(raw.depth) ? raw.depth : null;
  if (depth === null) report.problem('.depth is required: a whole number from 1');
  const keyDepths = normalizeKeyDepths(raw.key_depths, report.at('.key_depths'));
  const skipKeys = requiredList(raw, 'skip_keys', report);
  return depth !== null && keyDepths && skipKeys ? { depth, keyDepths, skipKeys } : null;
}

function normalizeLayers(raw, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with overlay_folders, common_layer_discovery and duplicate_check');
    return null;
  }
  const overlayFolders = requiredList(raw, 'overlay_folders', report);
  const commonLayerDiscovery = requiredOneOf(raw, 'common_layer_discovery', COMMON_LAYER_DISCOVERIES, report);
  const duplicateCheck = normalizeDuplicateCheck(raw.duplicate_check, report.at('.duplicate_check'));
  if (!overlayFolders || !commonLayerDiscovery || !duplicateCheck) return null;
  return { overlayFolders, commonLayerDiscovery, duplicateCheck };
}

function normalizePlaceholder(raw, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with pattern and unscanned_paths');
    return null;
  }
  let pattern = null;
  if (!compiles(raw.pattern)) report.problem('.pattern is required: a regular expression');
  else if (!raw.pattern.includes('(?<body>')) {
    report.problem(".pattern must name the placeholder's body with a (?<body>...) group");
  } else ({ pattern } = raw);
  const unscannedPaths = normalizePathEntries(raw, 'unscanned_paths', report);
  return pattern && unscannedPaths ? { pattern, unscannedPaths } : null;
}

function normalizeMarkerFunction(raw, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with call_marker, splat_operator and calls_without_name_allowed');
    return null;
  }
  const callMarker = requiredText(raw, 'call_marker', 'the text that opens a call in a key', report);
  const splatOperator = requiredText(raw, 'splat_operator', 'the suffix that spreads a list into arguments', report);
  const callsWithoutNameAllowed = requiredBoolean(raw, 'calls_without_name_allowed', report);
  if (!callMarker || !splatOperator || callsWithoutNameAllowed === null) return null;
  return { callMarker, splatOperator, callsWithoutNameAllowed };
}

function normalizeFunction(raw, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping');
    return null;
  }
  let definitions = null;
  if (Array.isArray(raw.definitions) && raw.definitions.every((source) => FUNCTION_DEFINITIONS.includes(source))) {
    definitions = raw.definitions;
  } else {
    report.problem(`.definitions is required: a list from ${FUNCTION_DEFINITIONS.join(', ')}`);
  }
  const callResultReferencePositions = requiredPositions(raw, 'call_result_reference_positions', report);
  const callsNotAllowedAt = normalizePathEntries(raw, 'calls_not_allowed_at', report);
  const markerFunction = normalizeMarkerFunction(raw.marker_function, report.at('.marker_function'));
  if (!definitions || !callResultReferencePositions || !callsNotAllowedAt) return null;
  return { definitions, callResultReferencePositions, callsNotAllowedAt, markerFunction };
}

function normalizeScope(scopeName, raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping');
    return null;
  }
  const regions = requiredPaths(raw, 'regions', report);
  const laterItemsOfDeclaringList = requiredBoolean(raw, 'later_items_of_declaring_list', report);
  const namedByParentKey = requiredBoolean(raw, 'named_by_parent_key', report);
  const builtinNames = requiredList(raw, 'builtin_names', report);
  if (!regions || laterItemsOfDeclaringList === null || namedByParentKey === null || !builtinNames) return null;
  const logical = LOGICAL_SCOPE_NAME.test(scopeName);
  if (!logical && (builtinNames.length > 0 || namedByParentKey)) {
    report.problem(': builtin_names and named_by_parent_key are for a logical scope, named in capitals');
  }
  if (regions.length === 0 && !laterItemsOfDeclaringList) {
    report.problem(': a scope needs regions, or later_items_of_declaring_list');
  }
  return { regions, laterItemsOfDeclaringList, namedByParentKey, builtinNames };
}

function normalizeScopes(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' is required: a mapping of scope names');
    return {};
  }
  const scopes = {};
  for (const [scopeName, definition] of Object.entries(raw)) {
    const scope = normalizeScope(scopeName, definition, report.at(`.${scopeName}`));
    if (scope) scopes[scopeName] = scope;
  }
  return scopes;
}

function normalizeDeclaration(raw, scopes, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping');
    return null;
  }
  const tokens = parseAt(raw.path);
  if (!tokens) report.problem('.path is required: a JSONPath such as $.locals.*');
  const skipKeys = requiredList(raw, 'skip_keys', report);
  const excludeCandidates = requiredList(raw, 'exclude_candidates', report);
  const nameSource = requiredOneOf(raw, 'name_source', NAME_SOURCES, report);
  const keyToken = nullableOneOf(raw, 'key_token', KEY_TOKENS, report);
  const nameSpelling = requiredOneOf(raw, 'name_spelling', NAME_SPELLINGS, report);
  const metaArgumentName = nullableText(raw, 'meta_argument_name', 'the meta argument that holds the name', report);
  const declaresEveryName = requiredBoolean(raw, 'declares_every_name', report);
  const scopeName = requiredText(raw, 'scope_name', 'a scope declared under scopes', report);
  const keyTokenMissing = nameSource === 'key' && keyToken === null;
  if (keyTokenMissing) report.problem('.key_token is required when name_source is key');
  const argumentMissing = nameSource === 'meta_argument' && metaArgumentName === null;
  if (argumentMissing) report.problem('.meta_argument_name is required when name_source is meta_argument');
  const scopeMissing = Boolean(scopeName) && !scopes[scopeName];
  if (scopeMissing) report.problem(`: scope ${scopeName} is not declared in scopes`);
  const complete = tokens && skipKeys && excludeCandidates && nameSource && keyToken !== undefined
    && nameSpelling && metaArgumentName !== undefined && declaresEveryName !== null && scopeName;
  if (!complete || keyTokenMissing || argumentMissing || scopeMissing) return null;
  return {
    path: raw.path,
    tokens,
    skipKeys,
    excludeCandidates,
    nameSource,
    keyToken,
    nameSpelling,
    metaArgumentName,
    declaresEveryName,
    scopeName,
  };
}

function normalizeReference(raw, scopes, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping');
    return null;
  }
  const pattern = compiles(raw.pattern) ? raw.pattern : null;
  if (!pattern) report.problem('.pattern is required: a regular expression');
  const positions = requiredPositions(raw, 'positions', report);
  const textAfterNameAllowed = requiredBoolean(raw, 'text_after_name_allowed', report);
  const scopeName = requiredText(raw, 'scope_name', 'a scope declared under scopes', report);
  const scopeGroup = nullableText(raw, 'scope_group', 'the pattern group holding the parent key', report);
  const nameGroup = requiredText(raw, 'name_group', 'the pattern group holding the name', report);
  const scope = scopeName ? scopes[scopeName] : null;
  if (scopeName && !scope) report.problem(`: scope ${scopeName} is not declared in scopes`);
  const groupMissing = Boolean(scope) && scope.namedByParentKey && scopeGroup === null;
  if (groupMissing) report.problem(`.scope_group is required: ${scopeName} is named by a parent key`);
  const groupStray = Boolean(scope) && !scope.namedByParentKey && typeof scopeGroup === 'string';
  if (groupStray) report.problem(`.scope_group must be null: ${scopeName} is not named by a parent key`);
  const complete = pattern && positions && textAfterNameAllowed !== null && scope
    && scopeGroup !== undefined && nameGroup;
  if (!complete || groupMissing || groupStray) return null;
  return { pattern, positions, textAfterNameAllowed, scopeName, scopeGroup, nameGroup };
}

function rulesOf(raw, field, normalize, report) {
  if (!Array.isArray(raw[field])) {
    report.problem(`.${field} is required: a list, [] when empty`);
    return [];
  }
  return raw[field].map((rule, index) => normalize(rule, report.at(`.${field}[${index}]`))).filter(Boolean);
}

function normalizeLocals(raw, rules, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with scope_name');
    return null;
  }
  const scopeName = requiredText(raw, 'scope_name', 'the scope whose declarations are the locals', report);
  if (!scopeName) return null;
  if (!rules.scopes[scopeName]) {
    report.problem(`: scope ${scopeName} is not declared in scopes`);
    return null;
  }
  const declaredByKey = rules.declarations.some((rule) => rule.scopeName === scopeName
    && rule.nameSource === 'key' && !rule.declaresEveryName);
  if (!declaredByKey) report.problem(`: no declaration rule reads ${scopeName} names from keys`);
  const referenced = rules.references.some((rule) => rule.scopeName === scopeName);
  if (!referenced) report.problem(`: no reference rule reads ${scopeName}`);
  return declaredByKey && referenced ? { scopeName } : null;
}

function normalizeDsl(raw, configProblems) {
  if (!isMapping(raw) || typeof raw.id !== 'string') return null;
  const report = createReport(configProblems, raw.id);
  const scopes = normalizeScopes(raw.scopes, report.at('.scopes'));
  const declarations = rulesOf(raw, 'declarations', (rule, at) => normalizeDeclaration(rule, scopes, at), report);
  const references = rulesOf(raw, 'references', (rule, at) => normalizeReference(rule, scopes, at), report);
  return {
    id: raw.id,
    fileIncludes: requiredList(raw, 'file_includes', report) || [],
    fileExcludes: requiredList(raw, 'file_excludes', report) || [],
    schemaSearchPaths: requiredList(raw, 'schema_search_paths', report) || [],
    layers: normalizeLayers(raw.layers, report.at('.layers')),
    placeholder: normalizePlaceholder(raw.placeholder, report.at('.placeholder')),
    function: normalizeFunction(raw.function, report.at('.function')),
    locals: normalizeLocals(raw.locals, { scopes, declarations, references }, report.at('.locals')),
    keySortOrders: normalizeKeySortOrders(raw, report),
    scopes,
    declarations,
    references,
  };
}

const DSL_READERS_BY_VERSION = { '1': normalizeDsl };

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
  const readDsl = typeof parsed.version === 'string' ? DSL_READERS_BY_VERSION[parsed.version] : null;
  if (!readDsl) {
    const versions = Object.keys(DSL_READERS_BY_VERSION).map((version) => `"${version}"`).join(', ');
    return { ok: false, error: `yaml-dsl.yml version is required: one of ${versions}`, dsls: [] };
  }
  const configProblems = [];
  const dsls = Array.isArray(parsed.dsls)
    ? parsed.dsls.map((raw) => readDsl(raw, configProblems)).filter(Boolean)
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
  return matchAny(dsl.fileIncludes, filePath) && !matchAny(dsl.fileExcludes, filePath);
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

module.exports = {
  COMMON_LAYER_DISCOVERIES,
  CONFIG_VERSIONS: Object.keys(DSL_READERS_BY_VERSION),
  FUNCTION_DEFINITIONS,
  KEY_SORT_ORDERS,
  KEY_TOKENS,
  LOGICAL_SCOPE_NAME,
  NAME_SOURCES,
  NAME_SPELLINGS,
  parseConfig,
  claimFile,
  ownsFile,
};

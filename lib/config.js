const path = require('path');
const YAML = require('yaml');
const { matchAny } = require('./glob');
const { CONCERN_TOKEN, namesConcern, commonLayerNameMatchOf } = require('./common-layer-names');
const { PATH_STEP_KINDS, parseAt } = require('./document-path');
const { REFERENCE_POSITIONS } = require('./reference-positions');
const { QUOTED_VALUE_TYPES } = require('./json-schema/validator');

const OVERLAY_INCLUDES = 'overlay_includes';
const COMMON_LAYER_DISCOVERIES = ['parent', 'ancestor', OVERLAY_INCLUDES];
const KEY_SORT_ORDERS = ['alphabetical', 'significance'];
const FUNCTION_DEFINITIONS = ['terraform', 'schema'];
const NAME_SOURCES = ['key', 'value', 'meta_argument'];
const KEY_TOKENS = ['all_words', 'first_word', 'last_word'];
const NAME_SPELLINGS = ['as_written', 'dashes_as_underscores'];
const LOGICAL_SCOPE_NAME = /^[A-Z][A-Z0-9_]*$/;
const CONFIG_FILE_NAME = 'yaml-dsl.yml';
const CONFIG_ROOT_TOKEN = '{config_root}';

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

function isFileName(text) {
  return typeof text === 'string' && text !== '' && text !== '.' && text !== '..' && !/[/\\]/.test(text);
}

function commonLayerNamesProblem(names, commonLayerDiscovery) {
  if (!Array.isArray(names) || names.length === 0 || !names.every(isFileName)) {
    return ' is required: a list of file names, the first tried first';
  }
  if (new Set(names).size !== names.length) return ' lists a name more than once';
  if (names.some((name) => name.split(CONCERN_TOKEN).length > 2)) {
    return ` holds ${CONCERN_TOKEN} more than once in a name`;
  }
  if (names.every(namesConcern)) {
    return ` holds no name without ${CONCERN_TOKEN}, the common layer of a concern above its overlays`;
  }
  if (commonLayerDiscovery === 'parent' && names.some(namesConcern)) {
    return ` names a ${CONCERN_TOKEN} common layer, which only common_layer_discovery: ancestor reaches`;
  }
  return null;
}

function normalizeCommonLayerFiles(raw, commonLayerDiscovery, report) {
  if (raw === undefined) return {};
  if (!isMapping(raw)) {
    report.problem(' must be a mapping of a layer file name to the names its common layer may take, in order');
    return null;
  }
  const commonLayerFiles = {};
  for (const [layerFileName, names] of Object.entries(raw)) {
    const problem = isFileName(layerFileName)
      ? commonLayerNamesProblem(names, commonLayerDiscovery)
      : ' is keyed by a layer file name';
    if (problem) report.at(`.${layerFileName}`).problem(problem);
    else commonLayerFiles[layerFileName] = names.slice();
  }
  return Object.keys(commonLayerFiles).length === Object.keys(raw).length ? commonLayerFiles : null;
}

function normalizeValueCondition(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with key and value');
    return null;
  }
  const key = requiredText(raw, 'key', 'the key the include value holds', report);
  const value = requiredText(raw, 'value', 'the value it holds at that key', report);
  return key && value ? { key, value } : null;
}

function normalizeLocationMapping(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with local and remote');
    return null;
  }
  const local = requiredText(raw, 'local', 'the local path a remote location stands for', report);
  const remote = requiredText(raw, 'remote', 'the start of a location', report);
  return local && remote ? { local, remote } : null;
}

function normalizeOverlayInclude(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with key_paths, value_conditions, location_path and location_mappings');
    return null;
  }
  const keyPaths = requiredPaths(raw, 'key_paths', report);
  const valueConditions = rulesOf(raw, 'value_conditions', normalizeValueCondition, report);
  const locationPath = parseAt(raw.location_path);
  const namesOnly = Boolean(locationPath) && locationPath.every((token) => token.kind === PATH_STEP_KINDS.name);
  if (!namesOnly) report.problem('.location_path is required: a JSONPath of names');
  const locationMappings = rulesOf(raw, 'location_mappings', normalizeLocationMapping, report);
  const complete = keyPaths && namesOnly
    && Array.isArray(raw.value_conditions) && valueConditions.length === raw.value_conditions.length
    && Array.isArray(raw.location_mappings) && locationMappings.length === raw.location_mappings.length;
  return complete ? { keyPaths, valueConditions, locationPath, locationMappings } : null;
}

function normalizeOverlayIncludeLayers(raw, duplicateCheck, report) {
  const unread = ['overlay_folders', 'common_layer_files'].filter((field) => Object.hasOwn(raw, field));
  for (const field of unread) report.problem(`.${field} is not read with common_layer_discovery ${OVERLAY_INCLUDES}`);
  const overlayIncludes = rulesOf(raw, OVERLAY_INCLUDES, normalizeOverlayInclude, report);
  const complete = Array.isArray(raw[OVERLAY_INCLUDES]) && overlayIncludes.length === raw[OVERLAY_INCLUDES].length;
  if (!complete || unread.length > 0 || !duplicateCheck) return null;
  return {
    overlayFolders: [],
    commonLayerDiscovery: OVERLAY_INCLUDES,
    commonLayerFiles: {},
    overlayIncludes,
    duplicateCheck,
  };
}

function normalizeLayers(raw, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with common_layer_discovery and duplicate_check');
    return null;
  }
  const commonLayerDiscovery = requiredOneOf(raw, 'common_layer_discovery', COMMON_LAYER_DISCOVERIES, report);
  const duplicateCheck = normalizeDuplicateCheck(raw.duplicate_check, report.at('.duplicate_check'));
  if (commonLayerDiscovery === OVERLAY_INCLUDES) return normalizeOverlayIncludeLayers(raw, duplicateCheck, report);
  const includesUnread = Object.hasOwn(raw, OVERLAY_INCLUDES);
  if (includesUnread) {
    report.problem(`.${OVERLAY_INCLUDES} is read only with common_layer_discovery ${OVERLAY_INCLUDES}`);
  }
  const overlayFolders = requiredList(raw, 'overlay_folders', report);
  const commonLayerFiles = normalizeCommonLayerFiles(
    raw.common_layer_files,
    commonLayerDiscovery,
    report.at('.common_layer_files'),
  );
  if (!overlayFolders || !commonLayerDiscovery || !commonLayerFiles || !duplicateCheck || includesUnread) return null;
  return { overlayFolders, commonLayerDiscovery, commonLayerFiles, overlayIncludes: [], duplicateCheck };
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
  const splatOperator = raw.splat_operator === null
    ? null
    : requiredText(raw, 'splat_operator', 'the suffix that spreads a list into arguments, or null', report);
  const splatStated = raw.splat_operator === null || splatOperator !== null;
  const callsWithoutNameAllowed = requiredBoolean(raw, 'calls_without_name_allowed', report);
  if (!callMarker || !splatStated || callsWithoutNameAllowed === null) return null;
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
  const pathSeparator = localPathSeparatorOf(raw.path_separator, report);
  return declaredByKey && referenced && pathSeparator !== undefined ? { scopeName, pathSeparator } : null;
}

function normalizeLoops(raw, rules, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with scope_name');
    return null;
  }
  const scopeName = requiredText(raw, 'scope_name', 'the scope whose reference rules read loop names', report);
  if (!scopeName) return null;
  if (!rules.scopes[scopeName]) {
    report.problem(`: scope ${scopeName} is not declared in scopes`);
    return null;
  }
  if (!rules.references.some((rule) => rule.scopeName === scopeName)) {
    report.problem(`: no reference rule reads ${scopeName}`);
    return null;
  }
  return { scopeName };
}

function localPathSeparatorOf(written, report) {
  if (written === undefined) return null;
  if (typeof written === 'string' && written !== '') return written;
  report.problem('.path_separator must be text: the text between the steps of a path into a local');
  return undefined;
}

function normalizeChildValueRule(raw, report) {
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with pattern');
    return null;
  }
  if (!compiles(raw.pattern)) {
    report.problem('.pattern is required: a regular expression');
    return null;
  }
  if (!raw.pattern.includes('(?<field>') || !raw.pattern.includes('(?<value>')) {
    report.problem('.pattern must name the child field and its value with (?<field>...) and (?<value>...) groups');
    return null;
  }
  return { pattern: raw.pattern };
}

function normalizeValidator(raw, report) {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with child_values_from_parent_key');
    return null;
  }
  const mergeBaseKeys = raw.merge_base_keys === undefined ? [] : requiredList(raw, 'merge_base_keys', report);
  const childValuesFromParentKey = rulesOf(raw, 'child_values_from_parent_key', normalizeChildValueRule, report);
  const allowQuotedValues = allowedQuotedValuesOf(raw.allow_quoted_values, report);
  if (!mergeBaseKeys || !Array.isArray(raw.child_values_from_parent_key)) return null;
  return { mergeBaseKeys, childValuesFromParentKey, allowQuotedValues };
}

function allowedQuotedValuesOf(listed, report) {
  if (listed === undefined) return [];
  if (Array.isArray(listed) && listed.every((type) => QUOTED_VALUE_TYPES.includes(type))) return listed;
  report.problem(`.allow_quoted_values must be a list from ${QUOTED_VALUE_TYPES.join(', ')}`);
  return [];
}

function normalizePerformance(raw, report) {
  if (raw === undefined) return { compiledSchemaCache: false };
  if (!isMapping(raw)) {
    report.problem(' must be a mapping with compiled_schema_cache');
    return { compiledSchemaCache: false };
  }
  return { compiledSchemaCache: requiredBoolean(raw, 'compiled_schema_cache', report) === true };
}

function normalizeTagKeys(raw, report) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    report.problem(' must be a list of tag and key pairs');
    return [];
  }
  const tagKeys = [];
  raw.forEach((entry, index) => {
    const entryReport = report.at(`[${index}]`);
    if (!isMapping(entry)) {
      entryReport.problem(' must be a mapping with tag and key');
      return;
    }
    const tag = typeof entry.tag === 'string' && /^![^\s!]+$/.test(entry.tag) ? entry.tag : null;
    if (!tag) entryReport.problem('.tag is required: a YAML tag as written, such as !Ref');
    const key = requiredText(entry, 'key', 'the key the tagged node stands for', entryReport);
    if (tag && tagKeys.some((listed) => listed.tag === tag)) {
      entryReport.problem(`.tag ${tag} is listed more than once`);
      return;
    }
    if (key && tagKeys.some((listed) => listed.key === key)) {
      entryReport.problem(`.key ${key} is listed more than once`);
      return;
    }
    if (tag && key) tagKeys.push({ tag, key });
  });
  return tagKeys;
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
    tagKeys: normalizeTagKeys(raw.tag_keys, report.at('.tag_keys')),
    layers: normalizeLayers(raw.layers, report.at('.layers')),
    placeholder: normalizePlaceholder(raw.placeholder, report.at('.placeholder')),
    function: normalizeFunction(raw.function, report.at('.function')),
    locals: normalizeLocals(raw.locals, { scopes, declarations, references }, report.at('.locals')),
    loops: normalizeLoops(raw.loops, { scopes, references }, report.at('.loops')),
    keySortOrders: normalizeKeySortOrders(raw, report),
    validator: normalizeValidator(raw.validator, report.at('.validator')),
    performance: normalizePerformance(raw.performance, report.at('.performance')),
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

function slashedPath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/\/$/, '');
}

function insideDir(filePath, dir) {
  const file = slashedPath(filePath);
  const root = slashedPath(dir);
  if (!root) return false;
  return file === root || file.startsWith(`${root}/`);
}

function configRootRelative(spec) {
  return spec.startsWith(`${CONFIG_ROOT_TOKEN}/`) ? spec.slice(CONFIG_ROOT_TOKEN.length + 1) : null;
}

function configPathOf(spec, configDir) {
  const relative = configRootRelative(spec);
  if (relative === null) return spec;
  return path.join(configDir, relative);
}

function globMatches(globs, filePath, configDir) {
  return globs.some((glob) => {
    const relative = configRootRelative(glob);
    if (relative === null) return matchAny([glob], filePath);
    return Boolean(configDir) && insideDir(filePath, configDir)
      && matchAny([relative], slashedPath(filePath).slice(slashedPath(configDir).length + 1));
  });
}

function ownsFile(dsl, filePath) {
  if (path.basename(String(filePath)) === CONFIG_FILE_NAME) return false;
  if (dsl.dir && !insideDir(filePath, dsl.dir)) return false;
  const nameMatch = dsl.layers
    ? commonLayerNameMatchOf(dsl.layers.commonLayerFiles, path.basename(String(filePath)))
    : null;
  const namesConcernCommonLayer = Boolean(nameMatch && nameMatch.concern !== null);
  return (globMatches(dsl.fileIncludes, filePath, dsl.dir) || namesConcernCommonLayer)
    && !globMatches(dsl.fileExcludes, filePath, dsl.dir);
}

function deepestConfigDirOf(filePath, dirs) {
  return dirs
    .filter((dir) => insideDir(filePath, dir))
    .reduce((deepest, dir) => (deepest === null || slashedPath(dir).length > slashedPath(deepest).length
      ? dir
      : deepest), null);
}

function claimFile(filePath, dsls) {
  const configDir = deepestConfigDirOf(filePath, dsls.map((dsl) => dsl.dir).filter(Boolean));
  const hits = dsls.filter((dsl) => (!dsl.dir || dsl.dir === configDir) && ownsFile(dsl, filePath));
  if (hits.length === 0) return { status: 'none' };
  if (hits.length > 1) return { status: 'many', ids: hits.map((dsl) => dsl.id) };
  return { status: 'one', dsl: hits[0] };
}

module.exports = {
  COMMON_LAYER_DISCOVERIES,
  OVERLAY_INCLUDES,
  CONFIG_VERSIONS: Object.keys(DSL_READERS_BY_VERSION),
  FUNCTION_DEFINITIONS,
  KEY_SORT_ORDERS,
  KEY_TOKENS,
  LOGICAL_SCOPE_NAME,
  NAME_SOURCES,
  NAME_SPELLINGS,
  CONFIG_FILE_NAME,
  CONFIG_ROOT_TOKEN,
  parseConfig,
  claimFile,
  configPathOf,
  configRootRelative,
  insideDir,
  ownsFile,
};

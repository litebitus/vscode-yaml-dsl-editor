const path = require('path');
const { readDslDefinitions, YAML_DSL_VERSIONS } = require('yaml-dsl-spec');
const { matchAny } = require('./glob');
const { commonLayerNameMatchOf } = require('./common-layer-names');
const { parseAt } = require('./document-path');

const OVERLAY_INCLUDES = 'overlay_includes';
const CONFIG_FILE_NAME = 'yaml-dsl.yml';
const CONFIG_ROOT_TOKEN = '{config_root}';

function pathEntriesOf(entries, moreFields = () => ({})) {
  return (entries || []).map((entry) => ({
    path: entry.path,
    tokens: parseAt(entry.path),
    skipKeys: entry.skip_keys,
    includesSubtree: entry.includes_subtree === true,
    ...moreFields(entry),
  }));
}

function duplicateCheckOf(written) {
  return { depth: written.depth, keyDepths: { ...written.key_depths }, skipKeys: written.skip_keys };
}

function overlayIncludeOf(written) {
  return {
    keyPaths: written.key_paths.map(parseAt),
    valueConditions: written.value_conditions.map(({ key, value }) => ({ key, value })),
    locationPath: parseAt(written.location_path),
    locationMappings: written.location_mappings.map(({ local, remote }) => ({ local, remote })),
  };
}

function layersOf(written) {
  if (!written) return null;
  const duplicateCheck = duplicateCheckOf(written.duplicate_check);
  if (written.common_layer_discovery === OVERLAY_INCLUDES) {
    return {
      overlayFolders: [],
      commonLayerDiscovery: OVERLAY_INCLUDES,
      commonLayerFiles: {},
      overlayIncludes: written.overlay_includes.map(overlayIncludeOf),
      duplicateCheck,
    };
  }
  const commonLayerFiles = Object.fromEntries(Object.entries(written.common_layer_files || {})
    .map(([layerFileName, names]) => [layerFileName, names.slice()]));
  return {
    overlayFolders: written.overlay_folders,
    commonLayerDiscovery: written.common_layer_discovery,
    commonLayerFiles,
    overlayIncludes: [],
    duplicateCheck,
  };
}

function placeholderOf(written) {
  if (!written) return null;
  return {
    pattern: written.pattern,
    escapePrefix: written.escape_prefix === undefined ? null : written.escape_prefix,
    unscannedPaths: pathEntriesOf(written.unscanned_paths),
  };
}

function markerFunctionOf(written) {
  if (!written) return null;
  return {
    callMarker: written.call_marker,
    splatOperator: written.splat_operator,
    callsWithoutNameAllowed: written.calls_without_name_allowed,
  };
}

function functionOf(written) {
  if (!written) return null;
  return {
    definitions: written.definitions,
    callResultReferencePositions: written.call_result_reference_positions,
    callsNotAllowedAt: pathEntriesOf(written.calls_not_allowed_at),
    markerFunction: markerFunctionOf(written.marker_function),
  };
}

function localsOf(written) {
  if (!written) return null;
  return {
    scopeName: written.scope_name,
    pathSeparator: written.path_separator === undefined ? null : written.path_separator,
  };
}

function loopsOf(written) {
  return written ? { scopeName: written.scope_name } : null;
}

function keySortOrdersOf(written) {
  return pathEntriesOf(written, (entry) => ({
    order: entry.order,
    firstKeys: entry.first_keys,
    lastKeys: entry.last_keys,
  }));
}

function validatorOf(written) {
  if (!written) return null;
  return {
    mergeBaseKeys: written.merge_base_keys || [],
    childValuesFromParentKey: written.child_values_from_parent_key.map(({ pattern }) => ({ pattern })),
    allowQuotedValues: written.allow_quoted_values || [],
  };
}

function performanceOf(written) {
  return { compiledSchemaCache: Boolean(written) && written.compiled_schema_cache === true };
}

function scopesOf(written) {
  return Object.fromEntries(Object.entries(written).map(([scopeName, scope]) => [scopeName, {
    regions: scope.regions.map(parseAt),
    laterItemsOfDeclaringList: scope.later_items_of_declaring_list,
    namedByParentKey: scope.named_by_parent_key,
    builtinNames: scope.builtin_names,
  }]));
}

function declarationOf(written) {
  return {
    path: written.path,
    tokens: parseAt(written.path),
    skipKeys: written.skip_keys,
    excludeCandidates: written.exclude_candidates,
    nameSource: written.name_source,
    keyToken: written.key_token,
    nameSpelling: written.name_spelling,
    metaArgumentName: written.meta_argument_name,
    declaresEveryName: written.declares_every_name,
    scopeName: written.scope_name,
  };
}

function referenceOf(written) {
  return {
    pattern: written.pattern,
    positions: written.positions,
    textAfterNameAllowed: written.text_after_name_allowed,
    scopeName: written.scope_name,
    scopeGroup: written.scope_group,
    nameGroup: written.name_group,
  };
}

/** A DSL block the standard's reader validated, as the editor's model of it. */
function dslOf(written) {
  return {
    id: written.id,
    fileIncludes: written.file_includes,
    fileExcludes: written.file_excludes,
    schemaSearchPaths: written.schema_search_paths,
    tagKeys: (written.tag_keys || []).map(({ tag, key }) => ({ tag, key })),
    layers: layersOf(written.layers),
    placeholder: placeholderOf(written.placeholder),
    function: functionOf(written.function),
    locals: localsOf(written.locals),
    loops: loopsOf(written.loops),
    keySortOrders: keySortOrdersOf(written.key_sort_orders),
    validator: validatorOf(written.validator),
    performance: performanceOf(written.performance),
    scopes: scopesOf(written.scopes),
    declarations: written.declarations.map(declarationOf),
    references: written.references.map(referenceOf),
  };
}

/**
 * A `yaml-dsl.yml`'s DSLs, read by the YAML DSL standard's reader: `{ ok, problems,
 * dsls }`, its problems each a diagnostic at the field it is about.
 */
function parseConfig(text, file = CONFIG_FILE_NAME) {
  const read = readDslDefinitions(file, text);
  if (read.problems) return { ok: false, problems: read.problems, dsls: [] };
  return { ok: true, problems: [], dsls: read.dsls.map(({ block }) => dslOf(block.toJson())) };
}

/**
 * Reads each folder's `yaml-dsl.yml`, and keeps the DSLs it last read cleanly while
 * the file holds problems, so the folder's documents keep their DSLs as it is edited.
 */
function createConfigReader() {
  const lastCleanDslsByDir = new Map();
  return function readConfig(dir, text) {
    const parsed = parseConfig(text, path.join(dir, CONFIG_FILE_NAME));
    if (parsed.ok) {
      lastCleanDslsByDir.set(dir, parsed.dsls);
      return parsed;
    }
    return { ...parsed, dsls: lastCleanDslsByDir.get(dir) || [] };
  };
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
  OVERLAY_INCLUDES,
  CONFIG_VERSIONS: YAML_DSL_VERSIONS,
  CONFIG_FILE_NAME,
  CONFIG_ROOT_TOKEN,
  parseConfig,
  createConfigReader,
  claimFile,
  configPathOf,
  configRootRelative,
  insideDir,
  ownsFile,
};

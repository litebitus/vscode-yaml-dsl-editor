const YAML = require('yaml');
const { parseConfig } = require('../lib/config');

const PLACEHOLDER_PATTERN = '\\$\\{(?<body>[^}\\n]*)\\}';

function scope(fields = {}) {
  return {
    regions: ['$'],
    later_items_of_declaring_list: false,
    named_by_parent_key: false,
    builtin_names: [],
    ...fields,
  };
}

function declaration(path, scopeName, fields = {}) {
  return {
    path,
    skip_keys: [],
    exclude_candidates: [],
    name_source: 'key',
    key_token: 'all_words',
    name_spelling: 'as_written',
    meta_argument_name: null,
    declares_every_name: false,
    scope_name: scopeName,
    ...fields,
  };
}

function reference(pattern, scopeName, fields = {}) {
  return {
    pattern,
    positions: ['whole_scalar'],
    text_after_name_allowed: false,
    scope_name: scopeName,
    scope_group: null,
    name_group: 'name',
    ...fields,
  };
}

function placeholder(fields = {}) {
  return { pattern: PLACEHOLDER_PATTERN, unscanned_paths: [], ...fields };
}

function markerFunction(fields = {}) {
  return {
    definitions: [],
    call_result_reference_positions: ['whole_scalar'],
    calls_not_allowed_at: [],
    marker_function: { call_marker: 'fn.', splat_operator: '*', calls_without_name_allowed: true },
    ...fields,
  };
}

function dslEntry(id, fields = {}) {
  return {
    id,
    file_includes: ['**/mock.yml'],
    file_excludes: [],
    schema_search_paths: [],
    scopes: {},
    declarations: [],
    references: [],
    ...fields,
  };
}

function configText(...dsls) {
  return YAML.stringify({ version: '1', dsls });
}

function parsedDsl(rawDsl) {
  const parsed = parseConfig(configText(rawDsl));
  if (parsed.error) throw new Error(parsed.error);
  return parsed.dsls[0];
}

module.exports = {
  PLACEHOLDER_PATTERN,
  scope,
  declaration,
  reference,
  placeholder,
  markerFunction,
  dslEntry,
  configText,
  parsedDsl,
};

const { configRootRelative } = require('./config');
const { concernCommonLayerGlobs } = require('./common-layer-names');

const YAML_DSL_LANGUAGE = 'yaml-dsl';
const BRACKETED_CHARACTERS = new Set(['?', '{', '}', '[']);
const CHARACTER_EDITOR_GLOBS_CANNOT_HOLD = ']';

function slashedPath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/\/+$/, '');
}

function editorGlobOf(glob) {
  if (glob.includes(CHARACTER_EDITOR_GLOBS_CANNOT_HOLD)) return null;
  return [...glob].map((character) => (BRACKETED_CHARACTERS.has(character) ? `[${character}]` : character)).join('');
}

function associationGlobOf(glob, configDir) {
  const root = slashedPath(configDir);
  const relative = configRootRelative(glob);
  if (relative !== null) return `${root}/${relative}`;
  if (glob.startsWith('**')) return `${root}/${glob}`;
  if (glob.startsWith(`${root}/`)) return glob;
  return null;
}

function fileAssociationsOf(dsls) {
  const associations = {};
  for (const dsl of dsls.filter((held) => held.dir)) {
    for (const glob of [...dsl.fileIncludes, ...concernCommonLayerGlobs(dsl.layers)]) {
      const associationGlob = associationGlobOf(glob, dsl.dir);
      const editorGlob = associationGlob === null ? null : editorGlobOf(associationGlob);
      if (editorGlob !== null) associations[editorGlob] = YAML_DSL_LANGUAGE;
    }
  }
  return associations;
}

function withFileAssociations(current, owned) {
  const kept = Object.entries(current || {})
    .filter(([pattern, language]) => language !== YAML_DSL_LANGUAGE || Object.hasOwn(owned, pattern));
  return { ...Object.fromEntries(kept), ...owned };
}

function withAddedFileAssociations(current, owned) {
  return { ...(current || {}), ...owned };
}

function sameAssociations(left, right) {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

module.exports = {
  YAML_DSL_LANGUAGE,
  fileAssociationsOf,
  withFileAssociations,
  withAddedFileAssociations,
  sameAssociations,
};

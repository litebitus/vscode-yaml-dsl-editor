const path = require('path');
const { configRootRelative } = require('./config');
const { concernCommonLayerGlobs } = require('./common-layer-names');

const YAML_DSL_LANGUAGE = 'yaml-dsl';
const BRACKETED_CHARACTERS = new Set(['?', '{', '}', '[']);
const CHARACTER_EDITOR_GLOBS_CANNOT_HOLD = ']';
const HOME_FOLDER_MARKER = '~';
const DRIVE_LETTER_START = /^[A-Za-z]:\//;

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

function associationPathKeyOf(pattern, homeFolder) {
  const slashed = pattern.replaceAll('\\', '/');
  const expanded = slashed === HOME_FOLDER_MARKER || slashed.startsWith(`${HOME_FOLDER_MARKER}/`)
    ? `${slashedPath(homeFolder)}${slashed.slice(HOME_FOLDER_MARKER.length)}`
    : slashed;
  if (!path.posix.isAbsolute(expanded) && !DRIVE_LETTER_START.test(expanded)) return expanded;
  return path.posix.normalize(expanded)
    .replace(DRIVE_LETTER_START, (driveStart) => driveStart.toLowerCase())
    .replace(/(.)\/+$/, '$1');
}

function associationsUpdate(settings, owned, dropUnstated) {
  const held = settings.workspaceValue || {};
  const keyOf = (pattern) => associationPathKeyOf(pattern, settings.homeFolder);
  const ownedKeys = new Set(Object.keys(owned).map(keyOf));
  const heldKeys = new Set([
    ...Object.keys(settings.userValue || {}),
    ...Object.keys(held).filter((pattern) => held[pattern] !== YAML_DSL_LANGUAGE),
  ].map(keyOf));
  const kept = Object.entries(held).filter(([pattern, language]) => {
    if (language !== YAML_DSL_LANGUAGE) return true;
    const key = keyOf(pattern);
    if (heldKeys.has(key) || (dropUnstated && !ownedKeys.has(key))) return false;
    heldKeys.add(key);
    return true;
  });
  const addedPatterns = Object.keys(owned).filter((pattern) => !heldKeys.has(keyOf(pattern)));
  return {
    ...Object.fromEntries(kept),
    ...Object.fromEntries(addedPatterns.map((pattern) => [pattern, YAML_DSL_LANGUAGE])),
  };
}

function withFileAssociations(settings, owned) {
  return associationsUpdate(settings, owned, true);
}

function withAddedFileAssociations(settings, owned) {
  return associationsUpdate(settings, owned, false);
}

function sameAssociations(left, right) {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

module.exports = {
  YAML_DSL_LANGUAGE,
  associationPathKeyOf,
  fileAssociationsOf,
  withFileAssociations,
  withAddedFileAssociations,
  sameAssociations,
};

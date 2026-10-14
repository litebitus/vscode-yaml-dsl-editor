const { escapeGlob } = require('./glob');

const CONCERN_TOKEN = '{concern}';

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function namesConcern(name) {
  return name.includes(CONCERN_TOKEN);
}

function concernMatchOf(name, fileName) {
  if (!namesConcern(name)) return null;
  const [before, after] = name.split(CONCERN_TOKEN);
  const match = new RegExp(`^${escapeRegExp(before)}([^/\\\\]+)${escapeRegExp(after)}$`).exec(fileName);
  return match ? match[1] : null;
}

function nameForConcern(name, concern) {
  return name.replace(CONCERN_TOKEN, concern);
}

function concernCommonLayerGlobs(layers) {
  const names = layers ? Object.values(layers.commonLayerFiles).flat().filter(namesConcern) : [];
  return [...new Set(names)].map((name) => `**/${name.split(CONCERN_TOKEN).map(escapeGlob).join('*')}`);
}

function commonLayerNameMatchOf(commonLayerFiles, fileName) {
  for (const [layerFileName, names] of Object.entries(commonLayerFiles)) {
    for (const name of names) {
      const concern = concernMatchOf(name, fileName);
      if (concern !== null) return { layerFileName, concern };
      if (name === fileName) return { layerFileName, concern: null };
    }
  }
  return null;
}

module.exports = {
  CONCERN_TOKEN,
  namesConcern,
  nameForConcern,
  concernCommonLayerGlobs,
  commonLayerNameMatchOf,
};

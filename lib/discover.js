const path = require('path');
const { namesConcern, nameForConcern, commonLayerNameMatchOf } = require('./common-layer-names');

function rootDepth(segments, rootDir) {
  const below = path.relative(rootDir, segments.join(path.sep) || path.sep);
  if (below.startsWith('..') || path.isAbsolute(below)) return segments.length;
  return segments.length - (below === '' ? 0 : below.split(path.sep).length);
}

function overlayIndexOf(segments, overlayNames, commonLayerDiscovery, rootDir) {
  const lowest = commonLayerDiscovery === 'parent' ? segments.length - 1 : rootDepth(segments, rootDir);
  for (let index = segments.length - 1; index >= lowest; index -= 1) {
    if (overlayNames.includes(segments[index])) return index;
  }
  return -1;
}

function commonCandidatesOf(commonDir, layerFileName, belowOverlay, commonLayerFiles) {
  const names = commonLayerFiles[layerFileName] || [layerFileName];
  const concern = belowOverlay.length > 0 ? belowOverlay[belowOverlay.length - 1] : null;
  return names
    .filter((name) => !namesConcern(name) || concern !== null)
    .map((name) => path.join(commonDir, namesConcern(name) ? nameForConcern(name, concern) : name));
}

function composedStack(commonDir, layerFileName, belowOverlay, activeOverlay, layers) {
  const { overlayFolders: overlayNames, commonLayerFiles = {} } = layers;
  const named = path.join(commonDir, layerFileName);
  const commonCandidates = commonCandidatesOf(commonDir, layerFileName, belowOverlay, commonLayerFiles);
  const overlays = {};
  for (const overlayName of overlayNames) {
    overlays[overlayName] = path.join(commonDir, overlayName, ...belowOverlay, layerFileName);
  }
  return {
    id: belowOverlay.length === 0 ? named : `${named}#${belowOverlay.join('/')}`,
    common: commonCandidates[0],
    commonCandidates,
    overlays,
    overlayNames: overlayNames.slice(),
    activeOverlay,
  };
}

function discoverStack(filePath, layers, rootDir) {
  const base = path.basename(filePath);
  const segments = path.dirname(filePath).split(path.sep);
  const overlayIndex = overlayIndexOf(segments, layers.overlayFolders, layers.commonLayerDiscovery, rootDir);
  if (overlayIndex >= 0) {
    const commonDir = segments.slice(0, overlayIndex).join(path.sep) || path.sep;
    return composedStack(commonDir, base, segments.slice(overlayIndex + 1), segments[overlayIndex], layers);
  }
  const commonDir = segments.join(path.sep) || path.sep;
  const commonLayerFiles = layers.commonLayerFiles || {};
  const nameMatch = Object.hasOwn(commonLayerFiles, base) ? null : commonLayerNameMatchOf(commonLayerFiles, base);
  if (!nameMatch) return composedStack(commonDir, base, [], null, layers);
  const belowOverlay = nameMatch.concern === null ? [] : [nameMatch.concern];
  return composedStack(commonDir, nameMatch.layerFileName, belowOverlay, null, layers);
}

function overlayNameOf(filePath, stack) {
  for (const [overlayName, overlayPath] of Object.entries(stack.overlays)) {
    if (overlayPath === filePath) return overlayName;
  }
  return null;
}

module.exports = { discoverStack, overlayNameOf };

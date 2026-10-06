const path = require('path');

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

function discoverStack(filePath, { overlayFolders: overlayNames, commonLayerDiscovery }, rootDir) {
  const base = path.basename(filePath);
  const segments = path.dirname(filePath).split(path.sep);
  const overlayIndex = overlayIndexOf(segments, overlayNames, commonLayerDiscovery, rootDir);
  const commonDir = (overlayIndex < 0 ? segments : segments.slice(0, overlayIndex)).join(path.sep) || path.sep;
  const belowOverlay = overlayIndex < 0 ? [] : segments.slice(overlayIndex + 1);
  const common = path.join(commonDir, base);
  const overlays = {};
  for (const overlayName of overlayNames) {
    overlays[overlayName] = path.join(commonDir, overlayName, ...belowOverlay, base);
  }
  return {
    id: belowOverlay.length === 0 ? common : `${common}#${belowOverlay.join('/')}`,
    common,
    overlays,
    overlayNames: overlayNames.slice(),
    activeOverlay: overlayIndex < 0 ? null : segments[overlayIndex],
  };
}

function overlayNameOf(filePath, stack) {
  for (const [overlayName, overlayPath] of Object.entries(stack.overlays)) {
    if (overlayPath === filePath) return overlayName;
  }
  return null;
}

module.exports = { discoverStack, overlayNameOf };

const path = require('path');

function discoverStack(filePath, overlayNames) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const parent = path.basename(dir);
  const inOverlay = overlayNames.includes(parent);
  const commonDir = inOverlay ? path.dirname(dir) : dir;
  const common = path.join(commonDir, base);
  const overlays = {};
  for (const overlayName of overlayNames) overlays[overlayName] = path.join(commonDir, overlayName, base);
  return {
    id: common,
    common,
    overlays,
    overlayNames: overlayNames.slice(),
    activeOverlay: inOverlay ? parent : null,
  };
}

function overlayNameOf(filePath, stack) {
  for (const [overlayName, overlayPath] of Object.entries(stack.overlays)) {
    if (overlayPath === filePath) return overlayName;
  }
  return null;
}

module.exports = { discoverStack, overlayNameOf };

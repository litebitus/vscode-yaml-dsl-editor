const { isPlainObject } = require('./merge');
const { canonicalJson } = require('./common-layer-suggestions');
const { flowValueText } = require('./flow-value-text');

const INDENT_WIDTH = 2;

function valueAtPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return { present: false, value: undefined };
    current = current[key];
  }
  return { present: true, value: current };
}

function keysInOverlayOrder(maps) {
  const keys = [];
  for (const map of maps) {
    for (const key of Object.keys(map)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function blockChildKeys(holderValues) {
  return holderValues.length > 0 && holderValues.every(isPlainObject) ? keysInOverlayOrder(holderValues) : [];
}

function groupsByValue(holders) {
  const groups = new Map();
  for (const { overlayName, value } of holders) {
    const valueKey = canonicalJson(value);
    if (!groups.has(valueKey)) groups.set(valueKey, { value, overlayNames: [] });
    groups.get(valueKey).overlayNames.push(overlayName);
  }
  return [...groups.values()];
}

function createLineWriter() {
  const lines = [];
  let differenceCount = 0;
  const indentOf = (depth) => ' '.repeat(depth * INDENT_WIDTH);
  const labelOf = (overlayNames) => `  # ${overlayNames.join(', ')}`;
  return {
    lines,
    differenceCount: () => differenceCount,
    nextDifference() {
      differenceCount += 1;
      return differenceCount - 1;
    },
    plain(depth, text) {
      lines.push({ text: `${indentOf(depth)}${text}`, differenceIndex: null, struck: null });
    },
    labeled(depth, text, overlayNames, differenceIndex) {
      lines.push({ text: `${indentOf(depth)}${text}${labelOf(overlayNames)}`, differenceIndex, struck: null });
    },
    struck(depth, keyText, overlayNames, differenceIndex) {
      const indent = indentOf(depth);
      const struckText = `${keyText}:`;
      lines.push({
        text: `${indent}${struckText}${labelOf(overlayNames)}`,
        differenceIndex,
        struck: { start: indent.length, end: indent.length + struckText.length },
      });
    },
  };
}

function renderEntry(writer, path, overlays, depth) {
  const keyText = flowValueText(path[path.length - 1]);
  const held = overlays.map((overlay) => ({
    overlayName: overlay.overlayName,
    ...valueAtPath(overlay.value, path),
  }));
  const holders = held.filter((entry) => entry.present);
  const lacking = held.filter((entry) => !entry.present).map((entry) => entry.overlayName);
  const childKeys = blockChildKeys(holders.map((entry) => entry.value));
  if (childKeys.length > 0) {
    writer.plain(depth, `${keyText}:`);
    for (const childKey of childKeys) renderEntry(writer, [...path, childKey], overlays, depth + 1);
    return;
  }
  const groups = groupsByValue(holders);
  if (groups.length === 1 && lacking.length === 0) {
    writer.plain(depth, `${keyText}: ${flowValueText(groups[0].value)}`);
    return;
  }
  const differenceIndex = writer.nextDifference();
  for (const group of groups) {
    writer.labeled(depth, `${keyText}: ${flowValueText(group.value)}`, group.overlayNames, differenceIndex);
  }
  if (lacking.length > 0) writer.struck(depth, keyText, lacking, differenceIndex);
}

function renderSelectedEntry(writer, path, overlays, depth) {
  const lacking = overlays.filter((overlay) => !valueAtPath(overlay.value, path).present);
  const holderValues = overlays
    .filter((overlay) => !lacking.includes(overlay))
    .map((overlay) => valueAtPath(overlay.value, path).value);
  if (lacking.length > 0 && blockChildKeys(holderValues).length > 0) {
    const keyText = flowValueText(path[path.length - 1]);
    writer.struck(depth, keyText, lacking.map((overlay) => overlay.overlayName), writer.nextDifference());
    renderEntry(writer, path, overlays.filter((overlay) => !lacking.includes(overlay)), depth);
    return;
  }
  renderEntry(writer, path, overlays, depth);
}

function overlayDiffLines(overlays, selectedPaths) {
  const writer = createLineWriter();
  let writtenAncestors = [];
  for (const path of selectedPaths) {
    const ancestors = path.slice(0, -1);
    let sharedDepth = 0;
    while (sharedDepth < ancestors.length && ancestors[sharedDepth] === writtenAncestors[sharedDepth]) {
      sharedDepth += 1;
    }
    for (let depth = sharedDepth; depth < ancestors.length; depth += 1) {
      writer.plain(depth, `${flowValueText(ancestors[depth])}:`);
    }
    writtenAncestors = ancestors;
    renderSelectedEntry(writer, path, overlays, ancestors.length);
  }
  return [headerLineOf(overlays, writer.differenceCount()), ...writer.lines];
}

function differenceCountText(differenceCount) {
  if (differenceCount === 0) return 'no differences';
  return differenceCount === 1 ? '1 difference' : `${differenceCount} differences`;
}

function headerLineOf(overlays, differenceCount) {
  const overlayNames = overlays.map((overlay) => overlay.overlayName).join(', ');
  return { text: `# ${overlayNames}: ${differenceCountText(differenceCount)}`, differenceIndex: null, struck: null };
}

function lastLineOf(entry) {
  const firstLine = entry.keyRange.start.line;
  if (!entry.value) return firstLine;
  const { end } = entry.value.range;
  const lastLine = end.character === 0 && end.line > firstLine ? end.line - 1 : end.line;
  return Math.max(firstLine, lastLine);
}

function deepestKeyPathAt(node, line, path) {
  if (!node || node.kind !== 'map' || node.flow) return null;
  for (const entry of node.entries) {
    if (entry.key === null || line < entry.keyRange.start.line || line > lastLineOf(entry)) continue;
    const entryPath = [...path, entry.key];
    return deepestKeyPathAt(entry.value, line, entryPath) || entryPath;
  }
  return null;
}

function selectedKeyPaths(tree, range) {
  const { start, end } = range;
  const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const paths = [];
  for (let line = start.line; line <= lastLine; line += 1) {
    const keyPath = deepestKeyPathAt(tree, line, []);
    if (keyPath && !paths.some((listed) => listed.join('\n') === keyPath.join('\n'))) paths.push(keyPath);
  }
  const holds = (ancestor, descendant) => ancestor.length < descendant.length
    && ancestor.every((key, index) => key === descendant[index]);
  return paths.filter((keyPath) => !paths.some((other) => holds(other, keyPath)));
}

module.exports = { overlayDiffLines, selectedKeyPaths };

const path = require('path');
const { pathMatches } = require('./document-path');
const { configPathOf } = require('./config');
const { deepMerge, isPlainObject, clone } = require('./merge');

function entryAt(node, key) {
  return node && node.kind === 'map' ? node.entries.findLast((entry) => entry.key === key) || null : null;
}

function nodeAtNames(node, tokens) {
  let current = node;
  for (const token of tokens) {
    const entry = entryAt(current, token.key);
    if (!entry) return null;
    current = entry.value;
  }
  return current;
}

function holdsConditions(includeValue, valueConditions) {
  return valueConditions.every(({ key, value }) => {
    const held = nodeAtNames(includeValue, [{ key }]);
    return Boolean(held) && held.kind === 'scalar' && String(held.value) === value;
  });
}

function commonLayerPathOf(location, locationMappings, overlayPath, configDir) {
  const mapping = locationMappings.find((candidate) => location.startsWith(candidate.remote));
  if (!mapping) return null;
  const local = configDir ? configPathOf(mapping.local, configDir) : mapping.local;
  const localStart = path.isAbsolute(local) ? local : path.resolve(path.dirname(overlayPath), local);
  return path.normalize(`${localStart}${location.slice(mapping.remote.length)}`);
}

function includeValuesOf(entryValue) {
  if (!entryValue) return [];
  return entryValue.kind === 'seq' ? entryValue.items.filter(Boolean) : [entryValue];
}

function overlayIncludesOf(tree, layers, overlayPath, configDir) {
  const includes = [];
  if (!tree || !layers || !layers.overlayIncludes || layers.overlayIncludes.length === 0) return includes;
  const visit = (node, documentPath) => {
    if (node && node.kind === 'seq') node.items.forEach((item, index) => visit(item, [...documentPath, index]));
    if (!node || node.kind !== 'map') return;
    for (const entry of node.entries) {
      if (entry.key === null) continue;
      const keyPath = [...documentPath, entry.key];
      const rule = layers.overlayIncludes.find((candidate) => candidate.keyPaths
        .some((tokens) => pathMatches(tokens, keyPath)));
      const includeValues = rule
        ? includeValuesOf(entry.value).filter((value) => value.kind === 'map'
          && holdsConditions(value, rule.valueConditions))
        : [];
      for (const includeValue of includeValues) {
        const locationNode = nodeAtNames(includeValue, rule.locationPath);
        const location = locationNode && locationNode.kind === 'scalar' && typeof locationNode.value === 'string'
          ? locationNode.value
          : null;
        includes.push({
          keyPath,
          holdingPath: documentPath,
          keyRange: entry.keyRange,
          location,
          locationRange: locationNode ? locationNode.range : entry.keyRange,
          commonLayerPath: location === null
            ? null
            : commonLayerPathOf(location, rule.locationMappings, overlayPath, configDir),
        });
      }
      if (includeValues.length === 0) visit(entry.value, keyPath);
    }
  };
  visit(tree, []);
  return includes;
}

function valueAtPath(value, documentPath) {
  return documentPath.reduce((held, step) => (held === null || held === undefined ? undefined : held[step]), value);
}

function withValueAtPath(value, documentPath, replacement) {
  if (documentPath.length === 0) return replacement;
  const [step, ...rest] = documentPath;
  const copy = Array.isArray(value) ? value.slice() : { ...value };
  copy[step] = withValueAtPath(value[step], rest, replacement);
  return copy;
}

function withoutKey(map, key) {
  const { [key]: removed, ...kept } = map;
  return kept;
}

function treeWithoutKeyAt(node, holdingPath, key) {
  if (!node) return node;
  if (holdingPath.length === 0) {
    return node.kind === 'map' ? { ...node, entries: node.entries.filter((entry) => entry.key !== key) } : node;
  }
  const [step, ...rest] = holdingPath;
  if (node.kind === 'map') {
    const entries = node.entries.map((entry) => (
      entry.key === step ? { ...entry, value: treeWithoutKeyAt(entry.value, rest, key) } : entry
    ));
    return { ...node, entries };
  }
  if (node.kind === 'seq') {
    const items = node.items.map((item, index) => (index === step ? treeWithoutKeyAt(item, rest, key) : item));
    return { ...node, items };
  }
  return node;
}

function docWithoutInclude(doc, include) {
  const includeKey = include.keyPath[include.keyPath.length - 1];
  const holding = valueAtPath(doc.value, include.holdingPath);
  return {
    ...doc,
    tree: treeWithoutKeyAt(doc.tree, include.holdingPath, includeKey),
    value: isPlainObject(holding)
      ? withValueAtPath(doc.value, include.holdingPath, withoutKey(holding, includeKey))
      : doc.value,
  };
}

function foldedValueOf(overlayValue, includes, commonLayerValueOf) {
  let folded = clone(overlayValue);
  const keyPathTexts = [...new Set(includes.map((include) => JSON.stringify(include.keyPath)))];
  for (const keyPathText of keyPathTexts) {
    const keyIncludes = includes.filter((include) => JSON.stringify(include.keyPath) === keyPathText);
    const commonValues = keyIncludes.map((include) => commonLayerValueOf(include.commonLayerPath));
    const { holdingPath, keyPath } = keyIncludes[0];
    const holding = valueAtPath(folded, holdingPath);
    if (!isPlainObject(holding) || !commonValues.every(isPlainObject)) continue;
    const merged = commonValues.reduce(
      (overlayHolding, commonValue) => deepMerge(commonValue, overlayHolding),
      withoutKey(holding, keyPath[keyPath.length - 1]),
    );
    folded = withValueAtPath(folded, holdingPath, merged);
  }
  return folded;
}

module.exports = { overlayIncludesOf, foldedValueOf, docWithoutInclude, valueAtPath };

const {
  parseFunctionKey,
  calledEntryOf,
  macroRoleParameterOf,
  macroArgumentNodesOf,
  macroArgumentValuesOf,
  macroRoleArgumentOf,
} = require('./function-calls');
const { matchWholeReferences, readsAt } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { localsScopeName } = require('./local-values');
const { valueAtPath } = require('./overlay-includes');
const { isPlainObject } = require('./merge');

function localNameReaderOf(dsl) {
  const scopeName = localsScopeName(dsl);
  const wholeRules = (dsl.references || [])
    .filter((rule) => rule.scopeName === scopeName && rule.positions.includes(WHOLE_SCALAR));
  return (text) => {
    if (!scopeName || typeof text !== 'string') return null;
    const reading = matchWholeReferences(text, wholeRules).find((candidate) => readsAt(candidate, WHOLE_SCALAR));
    return reading ? reading.groups[reading.rule.nameGroup] : null;
  };
}

function localReaderOf(dsl, writtenValue, localPaths) {
  const localNameOf = localNameReaderOf(dsl);
  function localValueOf(text, seenNames = new Set()) {
    const name = localNameOf(text);
    const localPath = name === null ? null : localPaths.get(name);
    if (!localPath || seenNames.has(name)) return undefined;
    const held = valueAtPath(writtenValue, localPath);
    const chained = typeof held === 'string' ? localValueOf(held, new Set([...seenNames, name])) : undefined;
    return chained === undefined ? held : chained;
  }
  return localValueOf;
}

function mergeContextOf(dsl, table, { writtenValue = {}, localPaths = new Map() } = {}) {
  const markerFunction = dsl.function ? dsl.function.markerFunction : null;
  return {
    markerFunction,
    table,
    localValueOf: localReaderOf(dsl, writtenValue, localPaths),
  };
}

function mergeCallOf(key, holdingKeyCount, context) {
  if (!context.markerFunction || !context.table) return null;
  const parsed = parseFunctionKey(key, context.markerFunction);
  if (!parsed || parsed.name !== null) return null;
  const called = calledEntryOf(context.table, parsed.functionName, holdingKeyCount > 1);
  const macro = called ? called.entry.macro : null;
  const contentParameter = macro && macro.kind === 'merge' ? macroRoleParameterOf(called.entry, 'content') : null;
  const mergesContents = Boolean(contentParameter) && contentParameter.type !== 'text';
  return mergesContents ? { parsed, entry: called.entry, contentParameter } : null;
}

function contentsOf(callValue, mergeCall) {
  const { parsed, entry, contentParameter } = mergeCall;
  const bound = macroRoleArgumentOf(macroArgumentValuesOf(callValue, entry.arguments), entry, 'content');
  const content = bound ? bound.value : undefined;
  return Array.isArray(content) && (parsed.splat || contentParameter.repeated) ? content : [content];
}

function deepMergedOf(base, over) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = isPlainObject(merged[key]) && isPlainObject(value) ? deepMergedOf(merged[key], value) : value;
  }
  return merged;
}

function mergedPairOf(base, over, mergeBehavior, joinedTwice) {
  if (mergeBehavior === 'deep') return deepMergedOf(base, over);
  if (mergeBehavior === 'join') {
    for (const key of Object.keys(over).filter((overKey) => Object.hasOwn(base, overKey))) joinedTwice.add(key);
  }
  return { ...base, ...over };
}

function mergedValueOf(value, context) {
  const pathMap = [];
  const requirementsSuppliedAt = new Set();
  const problems = [];
  function expandedChildrenOf(node, documentPath) {
    return Object.fromEntries(Object.entries(node)
      .map(([key, child]) => [key, expand(child, [...documentPath, key])]));
  }
  function expand(node, documentPath) {
    if (Array.isArray(node)) return node.map((item, index) => expand(item, [...documentPath, index]));
    if (!isPlainObject(node)) return node;
    const keyCount = Object.keys(node).length;
    const mergeCalls = Object.keys(node)
      .map((key) => ({ key, mergeCall: mergeCallOf(key, keyCount, context) }))
      .filter(({ mergeCall }) => mergeCall !== null);
    if (mergeCalls.length === 0) return expandedChildrenOf(node, documentPath);
    const callKeys = new Set(mergeCalls.map(({ key }) => key));
    const holding = Object.fromEntries(Object.entries(node).filter(([key]) => !callKeys.has(key)));
    let merged = {};
    let mergeBehavior = null;
    const contributingKeys = new Map();
    for (const { key, mergeCall } of mergeCalls) {
      mergeBehavior = mergeCall.entry.macro.mergeBehavior;
      const joinedTwice = new Set();
      for (const content of contentsOf(node[key], mergeCall)) {
        const resolved = isPlainObject(content) ? content : context.localValueOf(content);
        if (!isPlainObject(resolved)) {
          requirementsSuppliedAt.add(JSON.stringify(documentPath));
          continue;
        }
        merged = mergedPairOf(merged, resolved, mergeBehavior, joinedTwice);
        for (const contentKey of Object.keys(resolved)) contributingKeys.set(contentKey, key);
      }
      for (const twice of joinedTwice) problems.push({ path: [...documentPath, key], message: `\`${twice}\` is set twice in a join` });
    }
    const holdingJoinedTwice = new Set();
    const result = mergedPairOf(merged, holding, mergeBehavior, holdingJoinedTwice);
    const lastCallKey = mergeCalls[mergeCalls.length - 1].key;
    for (const twice of holdingJoinedTwice) {
      problems.push({ path: [...documentPath, lastCallKey], message: `\`${twice}\` is set twice in a join` });
    }
    for (const [contentKey, callKey] of contributingKeys) {
      if (!Object.hasOwn(holding, contentKey)) {
        pathMap.push({ mergedPath: [...documentPath, contentKey], sourcePath: [...documentPath, callKey] });
      }
    }
    return expandedChildrenOf(result, documentPath);
  }
  return { value: expand(value, []), pathMap, requirementsSuppliedAt, problems };
}

function treeNodeAtPath(tree, documentPath) {
  let node = tree;
  for (const step of documentPath) {
    if (node && node.kind === 'map') {
      const entry = node.entries.findLast((candidate) => candidate.key === step);
      node = entry ? entry.value : null;
    } else if (node && node.kind === 'seq' && typeof step === 'number') {
      node = node.items[step] || null;
    } else {
      return null;
    }
  }
  return node;
}

function localNodeReaderOf(dsl, localSymbols, fileOf) {
  const localNameOf = localNameReaderOf(dsl);
  function localNodeOf(text, seenNames) {
    const name = localNameOf(text);
    const symbol = name === null || seenNames.has(name) ? null : localSymbols.get(name);
    const file = symbol ? fileOf(symbol.file) : null;
    const node = file && file.tree ? treeNodeAtPath(file.tree, symbol.documentPath) : null;
    if (!node) return null;
    const throughNames = new Set([...seenNames, name]);
    if (node.kind === 'scalar') return localNodeOf(node.value, throughNames);
    return { node, source: { filePath: symbol.file, text: file.text }, seenNames: throughNames };
  }
  return localNodeOf;
}

function mergeTreeContextOf(dsl, table, { localSymbols = new Map(), fileOf = () => null } = {}) {
  return {
    markerFunction: dsl.function ? dsl.function.markerFunction : null,
    table,
    localNodeOf: localNodeReaderOf(dsl, localSymbols, fileOf),
  };
}

function mergeCallEntriesOf(node, context) {
  return node.entries
    .map((entry) => ({
      entry,
      mergeCall: entry.key === null ? null : mergeCallOf(entry.key, node.entries.length, context),
    }))
    .filter(({ mergeCall }) => mergeCall !== null);
}

function holdsMergeCalls(node, context) {
  if (!node || !context.markerFunction || !context.table) return false;
  if (node.kind === 'seq') return node.items.some((item) => holdsMergeCalls(item, context));
  if (node.kind !== 'map') return false;
  return mergeCallEntriesOf(node, context).length > 0
    || node.entries.some((entry) => holdsMergeCalls(entry.value, context));
}

function contentNodesOf(callNode, mergeCall) {
  const { parsed, entry, contentParameter } = mergeCall;
  const bound = macroRoleArgumentOf(macroArgumentNodesOf(callNode, entry.arguments), entry, 'content');
  const content = bound ? bound.node : null;
  return content && content.kind === 'seq' && (parsed.splat || contentParameter.repeated) ? content.items : [content];
}

function sourcedNodeOf(node, source) {
  if (!node) return node;
  if (node.kind === 'map') {
    const entries = node.entries
      .map((entry) => ({ ...entry, declaredIn: source, value: sourcedNodeOf(entry.value, source) }));
    return { ...node, declaredIn: source, entries };
  }
  if (node.kind === 'seq') {
    return { ...node, declaredIn: source, items: node.items.map((item) => sourcedNodeOf(item, source)) };
  }
  return { ...node, declaredIn: source };
}

function mergedEntriesOf(baseEntries, overEntries, mergeBehavior) {
  const merged = [...baseEntries];
  for (const over of overEntries) {
    const index = merged.findIndex((entry) => entry.key === over.key);
    if (index < 0) {
      merged.push(over);
      continue;
    }
    const base = merged[index];
    const deep = mergeBehavior === 'deep'
      && Boolean(base.value) && base.value.kind === 'map'
      && Boolean(over.value) && over.value.kind === 'map';
    const deepEntries = deep ? mergedEntriesOf(base.value.entries, over.value.entries, mergeBehavior) : null;
    merged[index] = deep ? { ...over, value: { ...over.value, entries: deepEntries } } : over;
  }
  return merged;
}

function mergedTreeOf(tree, context) {
  function contentEntriesOf(contentNode, seenNames) {
    if (contentNode && contentNode.kind === 'map') return expand(contentNode, seenNames).entries;
    if (!contentNode || contentNode.kind !== 'scalar') return [];
    const local = context.localNodeOf(contentNode.value, seenNames);
    if (!local || local.node.kind !== 'map') return [];
    return expand(sourcedNodeOf(local.node, local.source), local.seenNames).entries;
  }
  function expand(node, seenNames) {
    if (!node) return node;
    if (node.kind === 'seq') return { ...node, items: node.items.map((item) => expand(item, seenNames)) };
    if (node.kind !== 'map') return node;
    const mergeCalls = mergeCallEntriesOf(node, context);
    const holding = node.entries
      .filter((entry) => !mergeCalls.some(({ entry: callEntry }) => callEntry === entry))
      .map((entry) => ({ ...entry, value: expand(entry.value, seenNames) }));
    if (mergeCalls.length === 0) return { ...node, entries: holding };
    let merged = [];
    let mergeBehavior = null;
    for (const { entry, mergeCall } of mergeCalls) {
      mergeBehavior = mergeCall.entry.macro.mergeBehavior;
      for (const contentNode of contentNodesOf(entry.value, mergeCall)) {
        merged = mergedEntriesOf(merged, contentEntriesOf(contentNode, seenNames), mergeBehavior);
      }
    }
    return { ...node, entries: mergedEntriesOf(merged, holding, mergeBehavior) };
  }
  return expand(tree, new Set());
}

function startsWith(documentPath, prefix) {
  return prefix.length <= documentPath.length && prefix.every((step, index) => documentPath[index] === step);
}

function preMergePathOf(pathMap, documentPath) {
  const mapping = pathMap
    .filter((candidate) => startsWith(documentPath, candidate.mergedPath))
    .reduce((longest, candidate) => (
      !longest || candidate.mergedPath.length > longest.mergedPath.length ? candidate : longest
    ), null);
  return mapping ? mapping.sourcePath : documentPath;
}

module.exports = {
  mergeContextOf,
  mergedValueOf,
  preMergePathOf,
  mergeTreeContextOf,
  holdsMergeCalls,
  mergedTreeOf,
};

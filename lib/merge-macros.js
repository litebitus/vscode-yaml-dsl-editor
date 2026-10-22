const {
  parseFunctionKey,
  calledEntryOf,
  macroRoleParameterOf,
  macroArgumentNodesOf,
  macroArgumentValuesOf,
  macroRoleArgumentOf,
} = require('./function-calls');
const { matchWholeReferences } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { declaresLocalAt, localReferenceReaderOf } = require('./local-values');
const { valueAtPath } = require('./overlay-includes');
const { pathStartsWith } = require('./document-path');
const { isPlainObject } = require('./merge');

const LIST_INDEX = /^(0|[1-9][0-9]*)$/;

function valueReaderOf(callContext, dsl, writtenValue, localPaths) {
  const localReferenceOf = localReferenceReaderOf(dsl);
  const resolvingContents = new Set();
  function ownCallsMergedOf(map, markUnknown) {
    const mergeCalls = Object.keys(map)
      .map((key) => ({ key, mergeCall: mergeCallOf(key, callContext) }))
      .filter(({ mergeCall }) => mergeCall !== null);
    if (mergeCalls.length === 0) return map;
    const callKeys = new Set(mergeCalls.map(({ key }) => key));
    let merged = {};
    let mergeBehavior = null;
    for (const { key, mergeCall } of mergeCalls) {
      mergeBehavior = mergeCall.entry.macro.mergeBehavior;
      for (const content of contentsOf(map[key], mergeCall)) {
        const resolved = contentValueOf(content, markUnknown);
        if (isPlainObject(resolved)) merged = mergedPairOf(merged, resolved, mergeBehavior, new Set());
        else markUnknown();
      }
    }
    const holding = Object.fromEntries(Object.entries(map).filter(([key]) => !callKeys.has(key)));
    return mergedPairOf(merged, holding, mergeBehavior, new Set());
  }
  function contentValueOf(content, markUnknown) {
    if (isPlainObject(content)) return ownCallsMergedOf(content, markUnknown);
    if (typeof content !== 'string' || resolvingContents.has(content)) return undefined;
    const resolved = localValueOf(content);
    if (!isPlainObject(resolved)) return resolved;
    resolvingContents.add(content);
    const merged = ownCallsMergedOf(resolved, markUnknown);
    resolvingContents.delete(content);
    return merged;
  }
  function steppedValueOf(value, steps, seenNames) {
    if (typeof value === 'string' && localReferenceOf(value)) {
      const chained = localValueOf(value, seenNames);
      if (chained === undefined) return steps.length === 0 ? value : undefined;
      return steppedValueOf(chained, steps, seenNames);
    }
    if (steps.length === 0) return value;
    const [step, ...rest] = steps;
    if (Array.isArray(value) && LIST_INDEX.test(step)) return steppedValueOf(value[Number(step)], rest, seenNames);
    const map = isPlainObject(value) ? ownCallsMergedOf(value, () => {}) : null;
    if (map && Object.hasOwn(map, step)) return steppedValueOf(map[step], rest, seenNames);
    return undefined;
  }
  function localValueOf(text, seenNames = new Set()) {
    const reference = localReferenceOf(text);
    const localPath = reference ? localPaths.get(reference.name) : null;
    if (!localPath || seenNames.has(reference.name)) return undefined;
    const throughNames = new Set([...seenNames, reference.name]);
    return steppedValueOf(valueAtPath(writtenValue, localPath), reference.steps, throughNames);
  }
  return { localValueOf, contentValueOf };
}

function mergeContextOf(dsl, table, { writtenValue = {}, localPaths = new Map() } = {}) {
  const callContext = { markerFunction: dsl.function ? dsl.function.markerFunction : null, table };
  return { ...callContext, ...valueReaderOf(callContext, dsl, writtenValue, localPaths) };
}

function mergeCallOf(key, context) {
  if (!context.markerFunction || !context.table) return null;
  const parsed = parseFunctionKey(key, context.markerFunction);
  if (!parsed || parsed.name !== null) return null;
  const called = calledEntryOf(context.table, parsed.functionName, true);
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
    const mergeCalls = Object.keys(node)
      .map((key) => ({ key, mergeCall: mergeCallOf(key, context) }))
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
      const markUnknown = () => requirementsSuppliedAt.add(JSON.stringify(documentPath));
      for (const content of contentsOf(node[key], mergeCall)) {
        const resolved = context.contentValueOf(content, markUnknown);
        if (!isPlainObject(resolved)) {
          markUnknown();
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

function mergeTreeContextOf(dsl, table, { localSymbols = new Map(), fileOf = () => null } = {}) {
  return {
    dsl,
    markerFunction: dsl.function ? dsl.function.markerFunction : null,
    table,
    localSymbols,
    fileOf,
    localReferenceOf: localReferenceReaderOf(dsl),
    wholeReferenceRules: (dsl.references || []).filter((rule) => rule.positions.includes(WHOLE_SCALAR)),
    placeholderPattern: dsl.placeholder ? new RegExp(dsl.placeholder.pattern) : null,
  };
}

function mergeCallEntriesOf(node, context) {
  return node.entries
    .map((entry) => ({
      entry,
      mergeCall: entry.key === null ? null : mergeCallOf(entry.key, context),
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

function sourcedNodeOf(node, source, writtenPath) {
  if (!node) return node;
  if (node.kind === 'map') {
    const entries = node.entries.map((entry) => ({
      ...entry,
      declaredIn: source,
      value: sourcedNodeOf(entry.value, source, [...writtenPath, entry.key]),
    }));
    return { ...node, declaredIn: source, writtenPath, entries };
  }
  if (node.kind === 'seq') {
    const items = node.items.map((item, index) => sourcedNodeOf(item, source, [...writtenPath, index]));
    return { ...node, declaredIn: source, writtenPath, items };
  }
  return { ...node, declaredIn: source, writtenPath };
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

function isExpression(text, context) {
  return matchWholeReferences(text, context.wholeReferenceRules).length > 0
    || (Boolean(context.placeholderPattern) && context.placeholderPattern.test(text));
}

function treeMergerOf(context, filePath = null) {
  const landings = [];
  function mergedEntriesAt(node, seenNames, resolvedContentOf, holdingEntryOf = (entry) => entry) {
    const mergeCalls = mergeCallEntriesOf(node, context);
    const holding = node.entries
      .filter((entry) => !mergeCalls.some(({ entry: callEntry }) => callEntry === entry))
      .map(holdingEntryOf);
    if (mergeCalls.length === 0) return holding;
    let merged = [];
    let mergeBehavior = null;
    for (const { entry, mergeCall } of mergeCalls) {
      mergeBehavior = mergeCall.entry.macro.mergeBehavior;
      for (const contentNode of contentNodesOf(entry.value, mergeCall)) {
        merged = mergedEntriesOf(merged, resolvedContentOf(contentNode, entry, seenNames), mergeBehavior);
      }
    }
    return mergedEntriesOf(merged, holding, mergeBehavior);
  }
  function walkedContentOf(found, steps, seenNames) {
    const { node } = found;
    if (node && node.kind === 'scalar' && context.localReferenceOf(node.value)) {
      const chained = localContentOf(node.value, seenNames);
      if (!chained || chained.missing) return null;
      return walkedContentOf({ ...chained, heldSteps: found.heldSteps }, steps, chained.seenNames);
    }
    if (steps.length === 0) return { ...found, seenNames };
    const [step, ...rest] = steps;
    const missing = { missing: { step, heldSteps: found.heldSteps } };
    if (node && node.kind === 'map') {
      const entry = mergedEntriesAt(node, seenNames, shallowContentOf).findLast((candidate) => candidate.key === step);
      if (!entry) return missing;
      const next = { node: entry.value, filePath: entry.declaredIn.filePath, keyRange: entry.keyRange };
      return walkedContentOf({ ...next, heldSteps: [...found.heldSteps, step] }, rest, seenNames);
    }
    if (node && node.kind === 'seq' && LIST_INDEX.test(step)) {
      const item = node.items[Number(step)];
      if (!item) return missing;
      const next = { node: item, filePath: item.declaredIn.filePath, keyRange: item.range };
      return walkedContentOf({ ...next, heldSteps: [...found.heldSteps, step] }, rest, seenNames);
    }
    const unknown = !node
      || (node.kind === 'scalar' && typeof node.value === 'string' && isExpression(node.value, context));
    return unknown ? null : missing;
  }
  function localContentOf(text, seenNames) {
    const reference = context.localReferenceOf(text);
    if (!reference || seenNames.has(reference.name)) return null;
    return localContentAt(reference.name, reference.steps, seenNames);
  }
  function localContentAt(name, steps, seenNames) {
    const symbol = context.localSymbols.get(name);
    const file = symbol && !seenNames.has(name) ? context.fileOf(symbol.file) : null;
    const node = file && file.tree ? treeNodeAtPath(file.tree, symbol.documentPath) : null;
    if (!node) return null;
    const source = { filePath: symbol.file, text: file.text };
    const found = {
      node: sourcedNodeOf(node, source, symbol.documentPath),
      filePath: symbol.file,
      keyRange: symbol.keyRange,
      heldSteps: [],
    };
    return walkedContentOf(found, steps, new Set([...seenNames, name]));
  }
  function shallowContentOf(contentNode, callEntry, seenNames) {
    if (contentNode && contentNode.kind === 'map') return mergedEntriesAt(contentNode, seenNames, shallowContentOf);
    const found = contentNode && contentNode.kind === 'scalar' ? localContentOf(contentNode.value, seenNames) : null;
    if (!found || found.missing || !found.node || found.node.kind !== 'map') return [];
    return mergedEntriesAt(found.node, found.seenNames, shallowContentOf);
  }
  function landsAt(targetPath, key) {
    if (targetPath === null) return null;
    const childPath = [...targetPath, key];
    return declaresLocalAt(childPath, context.dsl) ? null : childPath;
  }
  function expandedContentOf(targetPath) {
    return (contentNode, callEntry, seenNames) => {
      if (contentNode && contentNode.kind === 'map') return expand(contentNode, seenNames, targetPath).entries;
      const found = contentNode && contentNode.kind === 'scalar' ? localContentOf(contentNode.value, seenNames) : null;
      if (!found || found.missing || !found.node || found.node.kind !== 'map') return [];
      if (targetPath !== null) {
        landings.push({
          filePath: found.filePath,
          writtenPath: found.node.writtenPath,
          targetPath,
          contentText: contentNode.value,
          call: {
            filePath: callEntry.declaredIn ? callEntry.declaredIn.filePath : filePath,
            keyRange: callEntry.keyRange,
          },
        });
      }
      return expand(found.node, found.seenNames, targetPath).entries;
    };
  }
  function expand(node, seenNames, targetPath) {
    if (!node) return node;
    if (node.kind === 'seq') {
      return { ...node, items: node.items.map((item, index) => expand(item, seenNames, landsAt(targetPath, index))) };
    }
    if (node.kind !== 'map') return node;
    const entries = mergedEntriesAt(node, seenNames, expandedContentOf(targetPath), (entry) => ({
      ...entry,
      value: expand(entry.value, seenNames, landsAt(targetPath, entry.key)),
    }));
    return { ...node, entries };
  }
  return { expand, localContentAt, localContentOf, landings };
}

function mergedTreeOf(tree, context) {
  return treeMergerOf(context).expand(tree, new Set(), null);
}

function mergeLandingsOf(tree, filePath, context) {
  const merger = treeMergerOf(context, filePath);
  merger.expand(tree, new Set(), []);
  return merger.landings;
}

function localContentAtSteps(name, steps, context) {
  return treeMergerOf(context).localContentAt(name, steps, new Set());
}

function localNodeOfReference(text, context) {
  const found = treeMergerOf(context).localContentOf(text, new Set());
  return found && !found.missing ? found.node : null;
}

function preMergePathOf(pathMap, documentPath) {
  const mapping = pathMap
    .filter((candidate) => pathStartsWith(documentPath, candidate.mergedPath))
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
  mergeLandingsOf,
  localContentAtSteps,
  localNodeOfReference,
};

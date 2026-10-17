const { parseFunctionKey, calledEntryOf } = require('./function-calls');
const { matchWholeReferences, readsAt } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { localsScopeName } = require('./local-values');
const { valueAtPath } = require('./overlay-includes');
const { isPlainObject } = require('./merge');

function localReaderOf(dsl, writtenValue, localPaths) {
  const scopeName = localsScopeName(dsl);
  const wholeRules = (dsl.references || [])
    .filter((rule) => rule.scopeName === scopeName && rule.positions.includes(WHOLE_SCALAR));
  function localValueOf(text, seenNames = new Set()) {
    if (!scopeName || typeof text !== 'string') return undefined;
    const reading = matchWholeReferences(text, wholeRules).find((candidate) => readsAt(candidate, WHOLE_SCALAR));
    const name = reading ? reading.groups[reading.rule.nameGroup] : null;
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
  const mergesContents = Boolean(macro) && macro.kind === 'merge' && called.entry.arguments[0].type !== 'text';
  return mergesContents ? { parsed, entry: called.entry } : null;
}

function contentsOf(argumentValue, mergeCall, context) {
  const { parsed, entry } = mergeCall;
  const bindsByTable = context.markerFunction.splatOperator === null && entry.arguments[0].repeated;
  return Array.isArray(argumentValue) && (parsed.splat || bindsByTable) ? argumentValue : [argumentValue];
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
      for (const content of contentsOf(node[key], mergeCall, context)) {
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

module.exports = { mergeContextOf, mergedValueOf, preMergePathOf };

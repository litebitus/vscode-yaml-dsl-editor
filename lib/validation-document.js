const { deepMerge, isPlainObject } = require('./merge');
const { parseFunctionKey } = require('./function-calls');
const { EXPRESSION_KINDS, expressionKindReader } = require('./expression-values');
const { loopContextOf, expandedValueOf, expandedPathOf, sourceProblemsOf } = require('./loops');
const { mergeContextOf, mergedValueOf, preMergePathOf } = require('./merge-macros');
const { resolvedDocumentOf, writtenPathOf } = require('./resolved-document');

const NO_VALIDATOR_RULES = { mergeBaseKeys: [], childValuesFromParentKey: [] };
const compiledPatternsByRules = new WeakMap();

function childValuePatternsOf(rules) {
  if (!compiledPatternsByRules.has(rules)) {
    compiledPatternsByRules.set(rules, rules.childValuesFromParentKey.map((rule) => new RegExp(rule.pattern)));
  }
  return compiledPatternsByRules.get(rules);
}

function childValueOf(key, patterns) {
  for (const pattern of patterns) {
    const match = key.match(pattern);
    if (match && match.groups && match.groups.field !== undefined && match.groups.value !== undefined) {
      return { field: match.groups.field, value: match.groups.value };
    }
  }
  return null;
}

function valueWithRulesApplied(node, rules, patterns) {
  if (Array.isArray(node)) return node.map((item) => valueWithRulesApplied(item, rules, patterns));
  if (!isPlainObject(node)) return node;
  const applied = {};
  for (const [key, value] of Object.entries(node)) {
    const child = valueWithRulesApplied(value, rules, patterns);
    const childValue = childValueOf(key, patterns);
    const setsField = childValue && isPlainObject(child) && !Object.hasOwn(child, childValue.field);
    applied[key] = setsField ? { ...child, [childValue.field]: childValue.value } : child;
  }
  for (const baseKey of rules.mergeBaseKeys.filter((key) => Object.hasOwn(applied, key))) {
    for (const [key, value] of Object.entries(applied)) {
      if (rules.mergeBaseKeys.includes(key) || !isPlainObject(value)) continue;
      applied[key] = deepMerge(applied[baseKey], value);
    }
  }
  return applied;
}

function scalarNodeOf(value) {
  return value !== null && typeof value !== 'object' ? { kind: 'scalar', value } : null;
}

function resolvedDocumentReadersOf(dsl, unknownMergeFunctionsAt) {
  const markerFunction = dsl.function ? dsl.function.markerFunction : null;
  const expressionKindOf = expressionKindReader(dsl);
  function unknownValueOf(node) {
    if (typeof node === 'string') {
      const kind = expressionKindOf(node, false);
      return kind ? { kind, value: { text: node } } : null;
    }
    if (!isPlainObject(node) || Object.keys(node).length !== 1) return null;
    const [key] = Object.keys(node);
    const kind = expressionKindOf(key, true, scalarNodeOf(node[key]));
    if (kind === EXPRESSION_KINDS.call) {
      return { kind, value: { function: parseFunctionKey(key, markerFunction).functionName } };
    }
    return kind ? { kind, value: { text: String(node[key]) } } : null;
  }
  function suppliedEntriesOf(map, key) {
    const call = parseFunctionKey(key, markerFunction);
    if (!call || call.name === null || Object.hasOwn(map, call.name)) return [];
    const suppliedValue = { kind: EXPRESSION_KINDS.call, value: { function: call.functionName } };
    return [{ key: call.name, sourceKey: key, value: suppliedValue }];
  }
  const unknownMergeFunctionAt = (documentPath) => (
    unknownMergeFunctionsAt.get(JSON.stringify(documentPath)) || null
  );
  return { unknownValueOf, suppliedEntriesOf, unknownMergeFunctionAt };
}

function lazily(compute) {
  let computed = null;
  return () => {
    if (computed === null) computed = { value: compute() };
    return computed.value;
  };
}

function validationDocumentOf(writtenValue, dsl, table = null, localPaths = new Map()) {
  const rules = dsl.validator || NO_VALIDATOR_RULES;
  const mergeContext = mergeContextOf(dsl, table, { writtenValue, localPaths });
  const loopContext = loopContextOf(dsl, table, { localValueOf: mergeContext.localValueOf });
  const expanded = expandedValueOf(writtenValue, loopContext);
  const merged = mergedValueOf(expanded.value, mergeContext);
  const value = valueWithRulesApplied(merged.value, rules, childValuePatternsOf(rules));
  const resolvedDocument = lazily(() => resolvedDocumentOf(
    merged.value,
    resolvedDocumentReadersOf(dsl, merged.unknownMergeFunctionsAt),
  ));
  const writtenProblemsOf = (problems) => problems
    .map((problem) => ({ ...problem, path: writtenPathOf(resolvedDocument(), problem.path) }));
  const preMergeProblemsOf = (problems) => problems
    .map((problem) => ({ ...problem, path: preMergePathOf(merged.pathMap, problem.path) }));
  return {
    value,
    resolvedDocument,
    sourceProblemsOf: (problems) => sourceProblemsOf(
      preMergeProblemsOf([...writtenProblemsOf(problems), ...merged.problems]),
      expanded.pathMap,
    ),
    expandedPathOf: (sourcePath) => expandedPathOf(expanded.pathMap, sourcePath),
  };
}

function validatorBlockOf(dsl) {
  if (!dsl.validator) return null;
  return {
    merge_base_keys: [...dsl.validator.mergeBaseKeys],
    child_values_from_parent_key: dsl.validator.childValuesFromParentKey.map(({ pattern }) => ({ pattern })),
    allow_quoted_values: [...(dsl.validator.allowQuotedValues || [])],
  };
}

function fieldSetByKey(key, dsl) {
  const rules = dsl.validator || NO_VALIDATOR_RULES;
  return childValueOf(key, childValuePatternsOf(rules));
}

module.exports = { validationDocumentOf, validatorBlockOf, fieldSetByKey };

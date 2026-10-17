const { deepMerge, isPlainObject } = require('./merge');
const { parseFunctionKey } = require('./function-calls');
const { loopContextOf, expandedValueOf, expandedPathOf, sourceProblemsOf } = require('./loops');

const REQUIRED_KEYWORD = 'required';
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

function valueHolds(value, path) {
  let node = value;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  return true;
}

function copiedFromMergeBase(writtenValue, path, mergeBaseKeys) {
  if (valueHolds(writtenValue, path)) return false;
  for (let siblingIndex = 1; siblingIndex < path.length; siblingIndex += 1) {
    const inBase = (baseKey) => valueHolds(writtenValue, [
      ...path.slice(0, siblingIndex),
      baseKey,
      ...path.slice(siblingIndex + 1),
    ]);
    if (mergeBaseKeys.some(inBase)) return true;
  }
  return false;
}

function callSuppliesField(value, path, field, markerFunction) {
  let node = value;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  if (!isPlainObject(node)) return false;
  return Object.keys(node).some((key) => {
    const call = parseFunctionKey(key, markerFunction);
    return Boolean(call) && call.name === field;
  });
}

function validationDocumentOf(writtenValue, dsl, table = null) {
  const rules = dsl.validator || NO_VALIDATOR_RULES;
  const markerFunction = dsl.function ? dsl.function.markerFunction : null;
  const mergeBaseKeys = new Set(rules.mergeBaseKeys);
  const expanded = expandedValueOf(writtenValue, loopContextOf(dsl, table));
  const value = valueWithRulesApplied(expanded.value, rules, childValuePatternsOf(rules));
  return {
    value,
    reports: (problem) => {
      if (problem.keyword === REQUIRED_KEYWORD) {
        if (problem.path.some((segment) => mergeBaseKeys.has(segment))) return false;
        const suppliedByCall = Boolean(markerFunction)
          && callSuppliesField(value, problem.path, problem.requiredField, markerFunction);
        if (suppliedByCall) return false;
      }
      return !copiedFromMergeBase(expanded.value, problem.path, rules.mergeBaseKeys);
    },
    sourceProblemsOf: (problems) => sourceProblemsOf(problems, expanded.pathMap),
    expandedPathOf: (sourcePath) => expandedPathOf(expanded.pathMap, sourcePath),
  };
}

function fieldSetByKey(key, dsl) {
  const rules = dsl.validator || NO_VALIDATOR_RULES;
  return childValueOf(key, childValuePatternsOf(rules));
}

module.exports = { validationDocumentOf, fieldSetByKey };

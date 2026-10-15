const { deepMerge, isPlainObject } = require('./merge');

const REQUIRED_KEYWORD = 'required';
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

function validationDocumentOf(writtenValue, rules) {
  if (!rules) return { value: writtenValue, reports: () => true };
  const mergeBaseKeys = new Set(rules.mergeBaseKeys);
  return {
    value: valueWithRulesApplied(writtenValue, rules, childValuePatternsOf(rules)),
    reports: (problem) => {
      if (problem.keyword === REQUIRED_KEYWORD && problem.path.some((segment) => mergeBaseKeys.has(segment))) {
        return false;
      }
      return !copiedFromMergeBase(writtenValue, problem.path, rules.mergeBaseKeys);
    },
  };
}

module.exports = { validationDocumentOf };

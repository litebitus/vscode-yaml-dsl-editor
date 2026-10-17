const { parseFunctionKey, calledEntryOf } = require('./function-calls');
const { scanPlaceholders } = require('./placeholder-scan');
const { isPlainObject } = require('./merge');

const BODY_INDEX = 2;
const LOOP_ARGUMENT_COUNT = 3;

function loopContextOf(dsl, table) {
  return {
    markerFunction: dsl.function ? dsl.function.markerFunction : null,
    table,
    placeholder: dsl.placeholder || null,
    references: dsl.references || [],
  };
}

function isLoopKey(key, context) {
  if (!context.markerFunction || !context.table || typeof key !== 'string') return false;
  const parsed = parseFunctionKey(key, context.markerFunction);
  const called = parsed ? calledEntryOf(context.table, parsed.functionName, true) : null;
  return Boolean(called && called.entry.macro && called.entry.macro.kind === 'loop');
}

function boundNameOf(placeholder, bindings) {
  const named = placeholder.readings
    .map((reading) => reading.groups[reading.rule.nameGroup])
    .find((name) => bindings.has(name));
  if (named !== undefined) return named;
  const body = placeholder.body.trim();
  return bindings.has(body) ? body : null;
}

function substitutedText(text, bindings, context) {
  if (bindings.size === 0 || !context.placeholder || typeof text !== 'string') return text;
  let substituted = '';
  let cursor = 0;
  for (const placeholder of scanPlaceholders(text, context.placeholder, context.references)) {
    const name = boundNameOf(placeholder, bindings);
    if (name === null) continue;
    substituted += text.slice(cursor, placeholder.start) + bindings.get(name);
    cursor = placeholder.end;
  }
  return substituted + text.slice(cursor);
}

function escapedExpression(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namePatternOf(text, loopVariables, context) {
  if (!context.placeholder) return null;
  let pattern = '';
  let cursor = 0;
  let bound = false;
  for (const placeholder of scanPlaceholders(text, context.placeholder, context.references)) {
    if (boundNameOf(placeholder, loopVariables) === null) continue;
    pattern += `${escapedExpression(text.slice(cursor, placeholder.start))}.+`;
    cursor = placeholder.end;
    bound = true;
  }
  return bound ? new RegExp(`^${pattern}${escapedExpression(text.slice(cursor))}$`) : null;
}

function writtenItemsOf(items) {
  const scalar = (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item);
  return Array.isArray(items) && items.every(scalar) ? items.map(String) : null;
}

function loopValueOf(value) {
  if (!Array.isArray(value) || value.length !== LOOP_ARGUMENT_COUNT) return null;
  const [loopVariable, collection, body] = value;
  if (typeof loopVariable !== 'string' || !isPlainObject(body)) return null;
  return { loopVariable, items: writtenItemsOf(collection), body };
}

function loopNodeOf(node) {
  if (!node || node.kind !== 'seq' || node.items.length !== LOOP_ARGUMENT_COUNT) return null;
  const [variableNode, collectionNode, bodyNode] = node.items;
  const loopVariable = variableNode && variableNode.kind === 'scalar' && typeof variableNode.value === 'string'
    ? variableNode.value
    : null;
  if (loopVariable === null || !bodyNode || bodyNode.kind !== 'map') return null;
  const collectionItems = collectionNode && collectionNode.kind === 'seq'
    && collectionNode.items.every((item) => item && item.kind === 'scalar')
    ? collectionNode.items.map((item) => item.value)
    : null;
  return { loopVariable, loopVariableRange: variableNode.range, items: writtenItemsOf(collectionItems), bodyNode };
}

function loopsOf(tree, context) {
  const loops = [];
  function visit(node, documentPath, enclosing) {
    if (!node) return;
    if (node.kind === 'seq') {
      node.items.forEach((item, index) => visit(item, [...documentPath, index], enclosing));
      return;
    }
    if (node.kind !== 'map') return;
    for (const entry of node.entries) {
      const entryPath = [...documentPath, entry.key];
      const loopNode = isLoopKey(entry.key, context) ? loopNodeOf(entry.value) : null;
      if (!loopNode) {
        visit(entry.value, entryPath, enclosing);
        continue;
      }
      const loop = {
        key: entry.key,
        keyRange: entry.keyRange,
        holdingPath: documentPath,
        bodyPath: [...entryPath, BODY_INDEX],
        loopVariable: loopNode.loopVariable,
        loopVariableRange: loopNode.loopVariableRange,
        items: loopNode.items,
        enclosing,
      };
      loops.push(loop);
      visit(loopNode.bodyNode, loop.bodyPath, loop);
    }
  }
  visit(tree, [], null);
  return loops;
}

function startsWith(documentPath, prefix) {
  return prefix.length <= documentPath.length && prefix.every((step, index) => documentPath[index] === step);
}

function loopOfVariableAt(loops, documentPath, name) {
  const deeper = (innermost, loop) => (
    !innermost || loop.bodyPath.length > innermost.bodyPath.length ? loop : innermost
  );
  return loops
    .filter((loop) => loop.loopVariable === name && startsWith(documentPath, loop.bodyPath))
    .reduce(deeper, null);
}

function expandedScalarNode(node, bindings, context) {
  if (!node || node.kind !== 'scalar' || typeof node.value !== 'string') return node;
  return { ...node, value: substitutedText(node.value, bindings, context) };
}

function expandedTreeOf(tree, context) {
  function expand(node, bindings, loopVariables) {
    if (!node) return node;
    if (node.kind === 'seq') return { ...node, items: node.items.map((item) => expand(item, bindings, loopVariables)) };
    if (node.kind !== 'map') return expandedScalarNode(node, bindings, context);
    return { ...node, entries: expandedEntriesOf(node.entries, bindings, loopVariables, false) };
  }
  function expandedEntriesOf(entries, bindings, loopVariables, inUnknownItems) {
    const expandedEntries = [];
    for (const entry of entries) {
      const loopNode = isLoopKey(entry.key, context) ? loopNodeOf(entry.value) : null;
      if (!loopNode) {
        const expanded = expandedEntry(entry, bindings, loopVariables);
        const namePattern = inUnknownItems ? namePatternOf(entry.key, loopVariables, context) : null;
        expandedEntries.push(namePattern ? { ...expanded, namePattern } : expanded);
        continue;
      }
      const bodyVariables = new Map(loopVariables).set(loopNode.loopVariable, loopNode.loopVariable);
      for (const item of loopNode.items || [loopNode.loopVariable]) {
        const itemBindings = new Map(bindings).set(loopNode.loopVariable, item);
        expandedEntries.push(...expandedEntriesOf(
          loopNode.bodyNode.entries,
          itemBindings,
          bodyVariables,
          inUnknownItems || !loopNode.items,
        ));
      }
    }
    return expandedEntries;
  }
  function expandedEntry(entry, bindings, loopVariables) {
    const key = substitutedText(entry.key, bindings, context);
    return { ...entry, key, value: expand(entry.value, bindings, loopVariables) };
  }
  return expand(tree, new Map(), new Map());
}

function expandedValueOf(value, context) {
  const pathMap = [];
  function expand(node, expandedPath, sourcePath, bindings, labels, combinations) {
    if (Array.isArray(node)) {
      return node.map((item, index) => (
        expand(item, [...expandedPath, index], [...sourcePath, index], bindings, labels, combinations)
      ));
    }
    if (typeof node === 'string') return substitutedText(node, bindings, context);
    if (!isPlainObject(node)) return node;
    const expanded = {};
    expandInto(expanded, node, { expandedPath, sourcePath, bindings, labels, combinations }, false);
    return expanded;
  }
  function expandInto(expanded, node, place, inBody) {
    const { expandedPath, sourcePath, bindings, labels, combinations } = place;
    for (const [key, child] of Object.entries(node)) {
      const loop = isLoopKey(key, context) ? loopValueOf(child) : null;
      if (!loop) {
        const expandedKey = substitutedText(key, bindings, context);
        const keyExpandedPath = [...expandedPath, expandedKey];
        const keySourcePath = [...sourcePath, key];
        if (inBody) pathMap.push({ expandedPath: keyExpandedPath, sourcePath: keySourcePath, labels, combinations });
        expanded[expandedKey] = expand(child, keyExpandedPath, keySourcePath, bindings, labels, combinations);
        continue;
      }
      const items = loop.items || [loop.loopVariable];
      for (const item of items) {
        expandInto(expanded, loop.body, {
          expandedPath,
          sourcePath: [...sourcePath, key, BODY_INDEX],
          bindings: new Map(bindings).set(loop.loopVariable, item),
          labels: [...labels, loop.items ? item : null],
          combinations: combinations * items.length,
        }, true);
      }
    }
  }
  return { value: expand(value, [], [], new Map(), [], 1), pathMap };
}

function longestMapping(pathMap, documentPath, side) {
  return pathMap
    .filter((mapping) => startsWith(documentPath, mapping[side]))
    .reduce((longest, mapping) => (!longest || mapping[side].length > longest[side].length ? mapping : longest), null);
}

function expandedPathOf(pathMap, sourcePath) {
  const mapping = longestMapping(pathMap, sourcePath, 'sourcePath');
  if (!mapping) return sourcePath;
  return [...mapping.expandedPath, ...sourcePath.slice(mapping.sourcePath.length)];
}

function labelOf(labels) {
  return labels.filter((label) => label !== null).map((label) => `\`${label}\``).join(' and ');
}

function sourceProblemsOf(problems, pathMap) {
  const groupsByKey = new Map();
  const groups = [];
  for (const problem of problems) {
    const mapping = longestMapping(pathMap, problem.path, 'expandedPath');
    const path = mapping ? [...mapping.sourcePath, ...problem.path.slice(mapping.expandedPath.length)] : problem.path;
    const groupKey = JSON.stringify([path, problem.message]);
    if (!groupsByKey.has(groupKey)) {
      const group = { problem: { ...problem, path }, labels: [], combinations: mapping ? mapping.combinations : 1 };
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }
    const label = mapping ? labelOf(mapping.labels) : '';
    if (label) groupsByKey.get(groupKey).labels.push(label);
  }
  return groups.map(({ problem, labels, combinations }) => (
    labels.length === 0 || labels.length === combinations
      ? problem
      : { ...problem, message: `${problem.message} (for ${labels.join(', ')})` }
  ));
}

module.exports = {
  loopContextOf,
  loopsOf,
  loopOfVariableAt,
  expandedTreeOf,
  expandedValueOf,
  expandedPathOf,
  sourceProblemsOf,
};

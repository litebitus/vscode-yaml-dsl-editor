const {
  parseFunctionKey,
  calledEntryOf,
  macroArgumentNodesOf,
  macroArgumentValuesOf,
  macroRoleArgumentOf,
  macroRoleParameterOf,
} = require('./function-calls');
const { scanPlaceholders, matchWholeReferences } = require('./placeholder-scan');
const { WHOLE_SCALAR } = require('./reference-positions');
const { pathStartsWith } = require('./document-path');
const { isPlainObject } = require('./merge');
const { codeSpan } = require('./json-schema/render');

function loopContextOf(dsl, table, { localValueOf = () => undefined, localNodeOf = () => null } = {}) {
  return {
    markerFunction: dsl.function ? dsl.function.markerFunction : null,
    table,
    placeholder: dsl.placeholder || null,
    references: dsl.references || [],
    loopScopeName: dsl.loops ? dsl.loops.scopeName : null,
    localValueOf,
    localNodeOf,
  };
}

function loopRulesOf(context) {
  return context.references.filter((rule) => rule.scopeName === context.loopScopeName);
}

function loopCallOf(key, context) {
  if (!context.markerFunction || !context.table || typeof key !== 'string') return null;
  const parsed = parseFunctionKey(key, context.markerFunction);
  const called = parsed ? calledEntryOf(context.table, parsed.functionName, true) : null;
  if (!called || !called.entry.macro || called.entry.macro.kind !== 'loop') return null;
  return { entry: called.entry, callName: parsed.name };
}

function boundNameOf(placeholder, bindings, context) {
  const loopRules = loopRulesOf(context);
  const reading = placeholder.readings.find((candidate) => loopRules.includes(candidate.rule)
    && candidate.trailingText === ''
    && bindings.has(candidate.groups[candidate.rule.nameGroup]));
  return reading ? reading.groups[reading.rule.nameGroup] : null;
}

function substitutedText(text, bindings, context) {
  if (bindings.size === 0 || !context.placeholder || typeof text !== 'string') return text;
  let substituted = '';
  let cursor = 0;
  for (const placeholder of scanPlaceholders(text, context.placeholder, context.references)) {
    const name = boundNameOf(placeholder, bindings, context);
    if (name === null) continue;
    substituted += text.slice(cursor, placeholder.start) + bindings.get(name);
    cursor = placeholder.end;
  }
  return substituted + text.slice(cursor);
}

function boundScalarOf(text, bindings, context) {
  if (bindings.size === 0 || typeof text !== 'string') return undefined;
  const wholeScalarRules = loopRulesOf(context).filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  const reading = matchWholeReferences(text, wholeScalarRules)
    .find((candidate) => candidate.trailingText === '' && bindings.has(candidate.groups[candidate.rule.nameGroup]));
  return reading ? bindings.get(reading.groups[reading.rule.nameGroup]) : undefined;
}

function expandedText(text, bindings, context) {
  const bound = boundScalarOf(text, bindings, context);
  return bound === undefined ? substitutedText(text, bindings, context) : bound;
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
    if (boundNameOf(placeholder, loopVariables, context) === null) continue;
    pattern += `${escapedExpression(text.slice(cursor, placeholder.start))}.+`;
    cursor = placeholder.end;
    bound = true;
  }
  return bound ? new RegExp(`^${pattern}${escapedExpression(text.slice(cursor))}$`) : null;
}

function isScalarItem(item) {
  return item === null || ['string', 'number', 'boolean'].includes(typeof item);
}

function collectionOfValue(value) {
  if (Array.isArray(value) && value.every(isScalarItem)) {
    return { keys: value.map((_, index) => String(index)), items: value.map(String), keyed: false };
  }
  if (isPlainObject(value) && Object.values(value).every(isScalarItem)) {
    const keys = Object.keys(value).sort();
    return { keys, items: keys.map((key) => String(value[key])), keyed: true };
  }
  return null;
}

function collectionOfNode(node) {
  if (!node) return null;
  if (node.kind === 'seq' && node.items.every((item) => item && item.kind === 'scalar')) {
    return collectionOfValue(node.items.map((item) => item.value));
  }
  if (node.kind === 'map' && node.entries.every((entry) => entry.value && entry.value.kind === 'scalar')) {
    return collectionOfValue(Object.fromEntries(node.entries.map((entry) => [entry.key, entry.value.value])));
  }
  return null;
}

function variablesOfValue(value) {
  if (typeof value === 'string' && value !== '') return [value];
  const isVariableName = (name) => typeof name === 'string' && name !== '';
  return Array.isArray(value) && [1, 2].includes(value.length) && value.every(isVariableName) ? value : null;
}

function defaultVariablesOf(entry) {
  const parameter = macroRoleParameterOf(entry, 'loopVariables');
  const variables = parameter ? variablesOfValue(parameter.default) : null;
  return variables ? variables.map((name) => ({ name, range: null })) : null;
}

function variablesOfNode(node, entry) {
  if (!node) return defaultVariablesOf(entry);
  if (node.kind === 'scalar' && variablesOfValue(node.value)) return [{ name: node.value, range: node.range }];
  const scalarItems = node.kind === 'seq' && node.items.every((item) => item && item.kind === 'scalar');
  if (!scalarItems || !variablesOfValue(node.items.map((item) => item.value))) return null;
  return node.items.map((item) => ({ name: item.value, range: item.range }));
}

function isBodyNode(node) {
  return Boolean(node) && (node.kind === 'map' || (node.kind === 'seq' && node.items.length === 1));
}

function isBodyValue(value) {
  return isPlainObject(value) || (Array.isArray(value) && value.length === 1);
}

function loopValueOf(value, entry, context) {
  if (!entry) return null;
  const bound = macroArgumentValuesOf(value, entry.arguments);
  const variablesArgument = macroRoleArgumentOf(bound, entry, 'loopVariables');
  const collectionArgument = macroRoleArgumentOf(bound, entry, 'collection');
  const bodyArgument = macroRoleArgumentOf(bound, entry, 'body');
  const variables = variablesArgument
    ? variablesOfValue(variablesArgument.value)
    : (defaultVariablesOf(entry) || []).map((named) => named.name);
  if (!variables || variables.length === 0 || !bodyArgument || !isBodyValue(bodyArgument.value)) return null;
  const collection = collectionArgument ? collectionArgument.value : undefined;
  return {
    variables,
    collection: collectionOfValue(typeof collection === 'string' ? context.localValueOf(collection) : collection),
    body: bodyArgument.value,
    bodyStep: bodyArgument.step,
  };
}

function loopNodeOf(node, entry, context) {
  if (!entry) return null;
  const bound = macroArgumentNodesOf(node, entry.arguments);
  const variablesArgument = macroRoleArgumentOf(bound, entry, 'loopVariables');
  const collectionArgument = macroRoleArgumentOf(bound, entry, 'collection');
  const bodyArgument = macroRoleArgumentOf(bound, entry, 'body');
  const variables = variablesOfNode(variablesArgument ? variablesArgument.node : null, entry);
  if (!variables || !bodyArgument || !isBodyNode(bodyArgument.node)) return null;
  const collectionNode = collectionArgument ? collectionArgument.node : null;
  const readsLocal = Boolean(collectionNode) && collectionNode.kind === 'scalar'
    && typeof collectionNode.value === 'string';
  return {
    variables,
    collection: collectionOfNode(readsLocal ? context.localNodeOf(collectionNode.value) : collectionNode),
    bodyNode: bodyArgument.node,
    bodyStep: bodyArgument.step,
  };
}

function passesOf(variables, collection) {
  if (!collection) return [{ bindings: variables.map((name) => [name, name]), label: null }];
  return collection.items.map((item, index) => ({
    bindings: variables.length === 1
      ? [[variables[0], item]]
      : [[variables[0], collection.keys[index]], [variables[1], item]],
    label: collection.keyed ? collection.keys[index] : item,
  }));
}

function withStep(documentPath, step) {
  return step === null ? documentPath : [...documentPath, step];
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
      const call = loopCallOf(entry.key, context);
      const loopNode = call ? loopNodeOf(entry.value, call.entry, context) : null;
      if (!loopNode) {
        visit(entry.value, entryPath, enclosing);
        continue;
      }
      const loop = {
        key: entry.key,
        keyRange: entry.keyRange,
        holdingPath: documentPath,
        bodyPath: withStep(entryPath, loopNode.bodyStep),
        variables: loopNode.variables.map((named) => named.name),
        variableRanges: loopNode.variables.map((named) => named.range || entry.keyRange),
        keys: loopNode.collection ? loopNode.collection.keys : null,
        items: loopNode.collection ? loopNode.collection.items : null,
        enclosing,
      };
      loops.push(loop);
      visit(loopNode.bodyNode, loop.bodyPath, loop);
    }
  }
  visit(tree, [], null);
  return loops;
}

function loopVariablesEnclosing(loops, file, documentPath) {
  const innermostByName = new Map();
  const enclosing = loops
    .filter((candidate) => candidate.file === file && pathStartsWith(documentPath, candidate.bodyPath));
  for (const loop of enclosing) {
    for (const name of loop.variables) {
      const held = innermostByName.get(name);
      if (!held || loop.bodyPath.length > held.bodyPath.length) innermostByName.set(name, loop);
    }
  }
  return [...innermostByName.entries()].map(([name, loop]) => ({ name, loop }));
}

function boundValuesOf(loop, name) {
  return loop.variables.length === 2 && loop.variables[0] === name ? loop.keys : loop.items;
}

function loopVariableDocumentationOf(loop, name) {
  const values = boundValuesOf(loop, name);
  const bound = values ? values.map((value) => codeSpan(value)).join(', ') : 'each item of its collection';
  return `${codeSpan(name)}: a loop variable of ${codeSpan(loop.key)}, bound to ${bound}`;
}

function loopOfVariableAt(loops, documentPath, name) {
  const deeper = (innermost, loop) => (
    !innermost || loop.bodyPath.length > innermost.bodyPath.length ? loop : innermost
  );
  return loops
    .filter((loop) => loop.variables.includes(name) && pathStartsWith(documentPath, loop.bodyPath))
    .reduce(deeper, null);
}

function expandedScalarNode(node, bindings, context) {
  if (!node || node.kind !== 'scalar' || typeof node.value !== 'string') return node;
  return { ...node, value: expandedText(node.value, bindings, context) };
}

function loneListLoopOf(entries, context) {
  if (entries.length !== 1) return null;
  const call = loopCallOf(entries[0].key, context);
  if (!call || call.callName !== null) return null;
  return { call, key: entries[0].key, written: entries[0].value };
}

function expandedTreeOf(tree, context) {
  function boundPasses(loopNode, bindings, loopVariables) {
    const bodyVariables = new Map(loopVariables);
    for (const named of loopNode.variables) bodyVariables.set(named.name, named.name);
    const passes = passesOf(loopNode.variables.map((named) => named.name), loopNode.collection)
      .map((pass) => new Map([...bindings, ...pass.bindings]));
    return { passes, bodyVariables };
  }
  function expandedListOf(loopNode, bindings, loopVariables) {
    const { passes, bodyVariables } = boundPasses(loopNode, bindings, loopVariables);
    const [element] = loopNode.bodyNode.items;
    return { ...loopNode.bodyNode, items: passes.map((passBindings) => expand(element, passBindings, bodyVariables)) };
  }
  function expand(node, bindings, loopVariables) {
    if (!node) return node;
    if (node.kind === 'seq') return { ...node, items: node.items.map((item) => expand(item, bindings, loopVariables)) };
    if (node.kind !== 'map') return expandedScalarNode(node, bindings, context);
    const lone = loneListLoopOf(node.entries, context);
    const loneNode = lone ? loopNodeOf(lone.written, lone.call.entry, context) : null;
    if (loneNode && loneNode.bodyNode.kind === 'seq') return expandedListOf(loneNode, bindings, loopVariables);
    return { ...node, entries: expandedEntriesOf(node.entries, bindings, loopVariables, false) };
  }
  function expandedEntriesOf(entries, bindings, loopVariables, inUnknownItems) {
    const expandedEntries = [];
    for (const entry of entries) {
      const call = loopCallOf(entry.key, context);
      const loopNode = call ? loopNodeOf(entry.value, call.entry, context) : null;
      if (!loopNode) {
        const expanded = expandedEntry(entry, bindings, loopVariables);
        const namePattern = inUnknownItems ? namePatternOf(entry.key, loopVariables, context) : null;
        expandedEntries.push(namePattern ? { ...expanded, namePattern } : expanded);
        continue;
      }
      const resultKey = call.callName === null ? null : substitutedText(call.callName, bindings, context);
      if (loopNode.bodyNode.kind === 'seq') {
        if (resultKey === null) continue;
        const value = expandedListOf(loopNode, bindings, loopVariables);
        expandedEntries.push({ ...entry, key: resultKey, value });
        continue;
      }
      const { passes, bodyVariables } = boundPasses(loopNode, bindings, loopVariables);
      const unknownItems = inUnknownItems || !loopNode.collection;
      const bodyEntries = passes.flatMap((passBindings) => expandedEntriesOf(
        loopNode.bodyNode.entries,
        passBindings,
        bodyVariables,
        unknownItems,
      ));
      if (resultKey === null) expandedEntries.push(...bodyEntries);
      else expandedEntries.push({ ...entry, key: resultKey, value: { ...loopNode.bodyNode, entries: bodyEntries } });
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
  function expandedList(loop, place) {
    const { expandedPath, sourcePath, bindings, labels, combinations } = place;
    const passes = passesOf(loop.variables, loop.collection);
    const elementSource = [...sourcePath, 0];
    return passes.map((pass, index) => {
      const elementPlace = {
        expandedPath: [...expandedPath, index],
        sourcePath: elementSource,
        bindings: new Map([...bindings, ...pass.bindings]),
        labels: [...labels, pass.label],
        combinations: combinations * passes.length,
      };
      pathMap.push({ ...elementPlace, bindings: undefined });
      return expand(loop.body[0], elementPlace);
    });
  }
  function expand(node, place) {
    const { expandedPath, sourcePath } = place;
    if (Array.isArray(node)) {
      return node.map((item, index) => expand(item, {
        ...place,
        expandedPath: [...expandedPath, index],
        sourcePath: [...sourcePath, index],
      }));
    }
    if (typeof node === 'string') return expandedText(node, place.bindings, context);
    if (!isPlainObject(node)) return node;
    const [onlyKey] = Object.keys(node);
    const lone = loneListLoopOf(Object.keys(node).map((key) => ({ key, value: node[key] })), context);
    const loneLoop = lone ? loopValueOf(node[onlyKey], lone.call.entry, context) : null;
    if (loneLoop && Array.isArray(loneLoop.body)) {
      return expandedList(loneLoop, { ...place, sourcePath: withStep([...sourcePath, onlyKey], loneLoop.bodyStep) });
    }
    const expanded = {};
    expandInto(expanded, node, place, false);
    return expanded;
  }
  function expandInto(expanded, node, place, inBody) {
    const { expandedPath, sourcePath, bindings, labels, combinations } = place;
    for (const [key, child] of Object.entries(node)) {
      const call = loopCallOf(key, context);
      const loop = call ? loopValueOf(child, call.entry, context) : null;
      if (!loop) {
        const expandedKey = substitutedText(key, bindings, context);
        const keyPlace = {
          ...place,
          expandedPath: [...expandedPath, expandedKey],
          sourcePath: [...sourcePath, key],
        };
        if (inBody) pathMap.push({ ...keyPlace, bindings: undefined });
        expanded[expandedKey] = expand(child, keyPlace);
        continue;
      }
      const bodySource = withStep([...sourcePath, key], loop.bodyStep);
      const resultKey = call.callName === null ? null : substitutedText(call.callName, bindings, context);
      const resultPath = resultKey === null ? expandedPath : [...expandedPath, resultKey];
      if (resultKey !== null) {
        pathMap.push({ expandedPath: resultPath, sourcePath: [...sourcePath, key], labels, combinations });
      }
      if (Array.isArray(loop.body)) {
        if (resultKey !== null) {
          expanded[resultKey] = expandedList(loop, { ...place, expandedPath: resultPath, sourcePath: bodySource });
        }
        continue;
      }
      const target = resultKey === null ? expanded : {};
      if (resultKey !== null) expanded[resultKey] = target;
      const passes = passesOf(loop.variables, loop.collection);
      for (const pass of passes) {
        expandInto(target, loop.body, {
          expandedPath: resultPath,
          sourcePath: bodySource,
          bindings: new Map([...bindings, ...pass.bindings]),
          labels: [...labels, pass.label],
          combinations: combinations * passes.length,
        }, true);
      }
    }
  }
  const root = { expandedPath: [], sourcePath: [], bindings: new Map(), labels: [], combinations: 1 };
  return { value: expand(value, root), pathMap };
}

function longestMapping(pathMap, documentPath, side) {
  return pathMap
    .filter((mapping) => pathStartsWith(documentPath, mapping[side]))
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
  loopVariablesEnclosing,
  loopVariableDocumentationOf,
  boundValuesOf,
  expandedTreeOf,
  expandedValueOf,
  expandedPathOf,
  sourceProblemsOf,
};

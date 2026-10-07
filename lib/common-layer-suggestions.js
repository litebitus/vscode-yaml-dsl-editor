const { parseYaml } = require('./tree');
const { deepMerge, isPlainObject } = require('./merge');
const { localsScopeName } = require('./local-values');
const {
  templateFor,
  fillTemplate,
  placeholderShape,
  wrapInPlaceholder,
} = require('./reference-template');
const { WHOLE_SCALAR, WHOLE_PLACEHOLDER } = require('./reference-positions');
const { pathMatches } = require('./document-path');
const {
  entryChain,
  deletionOf,
  insertionUnder,
  localsInsertion,
  placementIn,
  blockLines,
  normalizedEdits,
  applyEdits,
} = require('./common-layer-edits');

const NULL_LEAF_ID = 'null';

function localsKeysOf(dsl) {
  const scopeName = localsScopeName(dsl);
  if (!scopeName) return null;
  const rule = (dsl.declarations || []).find((candidate) => candidate.scopeName === scopeName
    && candidate.nameSource === 'key'
    && !candidate.declaresEveryName
    && candidate.tokens.length > 1
    && candidate.tokens.slice(0, -1).every((token) => token.kind === 'key')
    && candidate.tokens[candidate.tokens.length - 1].kind === 'star');
  return rule ? rule.tokens.slice(0, -1).map((token) => token.key) : null;
}

function localReferenceText(dsl, name) {
  const scopeName = localsScopeName(dsl);
  const symbol = { scope: scopeName, scopeName, name };
  const rules = (dsl.references || []).filter((rule) => rule.scopeName === scopeName && !rule.scopeGroup);
  for (const rule of rules.filter((candidate) => candidate.positions.includes(WHOLE_SCALAR))) {
    const template = templateFor(rule);
    const filled = template ? fillTemplate(template, symbol) : null;
    if (filled) return filled;
  }
  const shape = dsl.placeholder ? placeholderShape(dsl.placeholder) : null;
  if (!shape) return null;
  for (const rule of rules.filter((candidate) => candidate.positions.includes(WHOLE_PLACEHOLDER))) {
    const template = templateFor(rule, { leadingTextRequired: false });
    const body = template ? fillTemplate(template, symbol) : null;
    const wrapped = body ? wrapInPlaceholder(shape, body) : null;
    if (wrapped) return wrapped;
  }
  return null;
}

function entryOf(node, key) {
  if (!node || node.kind !== 'map' || node.flow) return null;
  return node.entries.find((entry) => entry.key === key) || null;
}

function childValue(node, key) {
  return node.entries.find((entry) => entry.key === key).value;
}

function startsWithKeys(longer, shorter) {
  return shorter.every((key, index) => longer[index] === key);
}

function touchesLocals(path, localsKeys) {
  if (!localsKeys) return false;
  return startsWithKeys(localsKeys, path) || startsWithKeys(path, localsKeys);
}

function leafId(node) {
  return node ? node.id : NULL_LEAF_ID;
}

function collectLeaves(nodes, relativePath, found) {
  const [first] = nodes;
  if (nodes.every((node) => leafId(node) === leafId(first))) {
    found.agreeing += 1;
    return;
  }
  if (!first || first.kind === 'scalar') {
    found.differing.push({ relativePath, nodes });
    return;
  }
  if (first.kind === 'map') {
    for (const entry of first.entries) {
      collectLeaves(nodes.map((node) => childValue(node, entry.key)), [...relativePath, entry.key], found);
    }
    return;
  }
  first.items.forEach((_, index) => {
    collectLeaves(nodes.map((node) => node.items[index]), [...relativePath, index], found);
  });
}

function nameSegment(step) {
  const words = String(step).split(/\s+/).filter(Boolean);
  return (words[words.length - 1] || '').replace(/[^A-Za-z0-9_]/g, '_');
}

function localNameFor(path, relativePath, takenNames, reservedNames) {
  const tail = [path[path.length - 1], ...relativePath].map(nameSegment);
  for (let ancestors = 0; ancestors < path.length; ancestors += 1) {
    const prefix = path.slice(path.length - 1 - ancestors, path.length - 1).map(nameSegment);
    const name = [...prefix, ...tail].join('_');
    if (!takenNames.has(name) && !reservedNames.has(name)) return name;
  }
  return null;
}

function rawText(doc, node) {
  return node ? doc.text.slice(node.start, node.end) : 'null';
}

function lightbulbMark(doc, entry) {
  const lineStart = doc.text.lastIndexOf('\n', entry.keyStart - 1) + 1;
  const newline = doc.text.indexOf('\n', entry.keyStart);
  const lineEnd = newline < 0 ? doc.text.length : newline;
  const position = { line: entry.keyRange.start.line, character: lineEnd - lineStart };
  return { file: doc.filePath, range: { start: position, end: { ...position } } };
}

function differencesOf(path, holders, values, context) {
  const found = { agreeing: 0, differing: [] };
  collectLeaves(values, [], found);
  if (found.differing.length === 0) return [];
  if (!context.localsKeys || found.agreeing === 0) return null;
  const differences = [];
  const reservedNames = new Set();
  for (const leaf of found.differing) {
    if (leaf.nodes.some((node) => !node || node.kind !== 'scalar')) return null;
    const texts = leaf.nodes.map((node, index) => rawText(context.overlayDocs.get(holders[index]), node));
    if (texts.some((text) => text.includes('\n'))) return null;
    const name = localNameFor(path, leaf.relativePath, context.takenNames, reservedNames);
    const referenceText = name ? localReferenceText(context.stack.dsl, name) : null;
    if (!referenceText) return null;
    reservedNames.add(name);
    const groups = [];
    leaf.nodes.forEach((node, index) => {
      const group = groups.find((candidate) => candidate.id === leafId(node));
      if (group) group.overlays.push(holders[index]);
      else groups.push({ id: leafId(node), text: texts[index], overlays: [holders[index]] });
    });
    const chosen = groups.reduce((best, group) => (group.overlays.length > best.overlays.length ? group : best));
    differences.push({ name, referenceText, leaf, groups, chosen });
  }
  return differences;
}

function keyTextsOf(doc, path) {
  return entryChain(doc.tree, path).map((entry) => doc.text.slice(entry.keyStart, entry.keyEnd));
}

function keyOrderFor(dsl, mapPath) {
  const covering = (dsl.keyOrders || []).find((entry) => pathMatches(entry.tokens, mapPath, entry));
  return covering ? covering.order : null;
}

function keysAt(doc, mapPath) {
  const map = mapPath.length === 0
    ? doc.tree
    : (entryChain(doc.tree, mapPath)[mapPath.length - 1] || {}).value;
  return map && map.kind === 'map' ? map.entries.map((entry) => entry.key) : [];
}

function placementsFrom(sourceDocs, dsl) {
  return (parentMap, parentPath, newKey) => {
    const order = keyOrderFor(dsl, parentPath);
    if (!order) return null;
    return placementIn(parentMap, newKey, order, sourceDocs.map((doc) => keysAt(doc, parentPath)));
  };
}

function moveEdits(path, holders, absent, differences, context) {
  const { commonDoc, overlayDocs, localsKeys, stack } = context;
  const sourceDoc = overlayDocs.get(holders[0]);
  const sourceEntry = entryChain(sourceDoc.tree, path)[path.length - 1];
  const keyTexts = keyTextsOf(sourceDoc, path);
  const placementFor = placementsFrom(holders.map((holder) => overlayDocs.get(holder)), stack.dsl);
  const replacements = differences.map((difference) => {
    const node = difference.leaf.nodes[0];
    return { start: node.start, end: node.end, text: difference.referenceText };
  });
  const editsByFile = new Map();
  const add = (filePath, ...edits) => {
    if (!editsByFile.has(filePath)) editsByFile.set(filePath, []);
    editsByFile.get(filePath).push(...edits);
  };
  const localsKeyTexts = localsKeys || [];
  const commonLocals = localsInsertion(commonDoc, localsKeyTexts, localsKeyTexts, differences.map((difference) => ({
    name: difference.name,
    valueText: difference.chosen.text,
  })), placementFor);
  if (!commonLocals) return null;
  add(stack.common, ...commonLocals);
  const block = insertionUnder(
    commonDoc,
    path,
    keyTexts,
    (indent) => blockLines(sourceDoc, sourceEntry, replacements, indent),
    placementFor,
  );
  if (!block) return null;
  add(stack.common, block);
  for (const holder of holders) {
    const doc = overlayDocs.get(holder);
    const deletion = deletionOf(doc, path);
    if (!deletion) return null;
    add(doc.filePath, deletion);
    const own = differences
      .filter((difference) => !difference.chosen.overlays.includes(holder))
      .map((difference) => ({
        name: difference.name,
        valueText: difference.groups.find((group) => group.overlays.includes(holder)).text,
      }));
    const ownLocals = localsInsertion(doc, localsKeyTexts, localsKeyTexts, own, placementFor);
    if (!ownLocals) return null;
    add(doc.filePath, ...ownLocals);
  }
  for (const name of absent) {
    const doc = overlayDocs.get(name);
    const optOut = insertionUnder(
      doc,
      path,
      keyTexts,
      (indent) => [`${' '.repeat(indent)}${keyTexts[path.length - 1]}: {}`],
      placementFor,
    );
    if (!optOut) return null;
    add(doc.filePath, optOut);
  }
  return normalizedFiles(editsByFile);
}

function normalizedFiles(editsByFile) {
  const normalized = new Map();
  for (const [filePath, edits] of editsByFile) {
    const merged = normalizedEdits(edits);
    if (!merged) return null;
    normalized.set(filePath, merged);
  }
  return normalized;
}

function suggestionRecord(kind, path, holders, entriesByOverlay, details, context) {
  return {
    id: JSON.stringify([kind, holders, path]),
    kind,
    path,
    overlayCount: context.overlayNames.length,
    holders,
    absent: details.absent,
    differences: details.differences.map((difference) => ({
      name: difference.name,
      referenceText: difference.referenceText,
      values: difference.groups.map((group) => ({ text: group.text, overlays: group.overlays })),
    })),
    schemaGroups: details.schemaGroups,
    optOutFailures: details.optOutFailures,
    optOutConditionalFields: details.optOutConditionalFields,
    marks: holders.map((name) => lightbulbMark(context.overlayDocs.get(name), entriesByOverlay.get(name))),
    edits: details.edits,
  };
}

function schemaGroupsOf(path, context) {
  const groups = [];
  for (const name of context.overlayNames) {
    const check = context.schemaChecks.nodeCheck(context.schemaHashOf(context.stack.overlays[name]), path);
    const group = groups.find((candidate) => candidate.check.fingerprint === check.fingerprint);
    if (group) group.overlays.push(name);
    else groups.push({ check, overlays: [name] });
  }
  return groups;
}

function optOutFailuresOf(absent, check) {
  const failures = absent.length > 0 ? check.optOutFailures() : [];
  if (failures.length === 0) return [];
  return absent.map((overlay) => ({ overlay, failures }));
}

function optOutConditionalFieldsOf(absent, check) {
  const fields = absent.length > 0 ? check.conditionallyRequiredFields() : [];
  if (fields.length === 0) return [];
  return absent.map((overlay) => ({ overlay, fields }));
}

function moveSuggestion(path, holders, entriesByOverlay, context) {
  const values = holders.map((name) => entriesByOverlay.get(name).value);
  const absent = context.overlayNames.filter((name) => !holders.includes(name));
  const differences = differencesOf(path, holders, values, context);
  if (differences === null) return null;
  const edits = moveEdits(path, holders, absent, differences, context);
  if (!edits) return null;
  const groups = schemaGroupsOf(path, context);
  const schemaGroups = groups.length > 1
    ? groups.map((group) => ({ overlays: group.overlays, state: group.check.state }))
    : [];
  const optOutFailures = schemaGroups.length > 0 ? [] : optOutFailuresOf(absent, groups[0].check);
  if (schemaGroups.length > 0 || optOutFailures.length > 0) {
    const details = {
      absent,
      differences: [],
      schemaGroups,
      optOutFailures,
      optOutConditionalFields: [],
      edits: new Map(),
    };
    return suggestionRecord('potential_move', path, holders, entriesByOverlay, details, context);
  }
  for (const difference of differences) context.takenNames.add(difference.name);
  const optOutConditionalFields = optOutConditionalFieldsOf(absent, groups[0].check);
  const details = { absent, differences, schemaGroups, optOutFailures, optOutConditionalFields, edits };
  return suggestionRecord('move', path, holders, entriesByOverlay, details, context);
}

function duplicateSuggestion(path, overlayName, entry, context) {
  const doc = context.overlayDocs.get(overlayName);
  const deletion = deletionOf(doc, path);
  if (!deletion) return null;
  const entriesByOverlay = new Map([[overlayName, entry]]);
  const details = {
    absent: [],
    differences: [],
    schemaGroups: [],
    optOutFailures: [],
    optOutConditionalFields: [],
    edits: new Map([[doc.filePath, [deletion]]]),
  };
  return suggestionRecord('delete', path, [overlayName], entriesByOverlay, details, context);
}

function holdsNull(node) {
  return !node || (node.kind === 'scalar' && node.value === null);
}

function visitDuplicates(path, overlayName, overlayNode, commonNode, context) {
  const { duplicateCheck } = context.stack.dsl.layers;
  if (!overlayNode || overlayNode.kind !== 'map' || overlayNode.flow) return;
  for (const entry of overlayNode.entries) {
    if (duplicateCheck.skipKeys.includes(entry.key)) continue;
    const entryPath = [...path, entry.key];
    const depth = Object.hasOwn(duplicateCheck.keyDepths, entryPath[0])
      ? duplicateCheck.keyDepths[entryPath[0]]
      : duplicateCheck.depth;
    if (entryPath.length > depth) continue;
    const commonEntry = entry.key === null ? null : entryOf(commonNode, entry.key);
    if (!commonEntry || holdsNull(entry.value) || holdsNull(commonEntry.value)) continue;
    if (entry.value.id === commonEntry.value.id) {
      const suggestion = duplicateSuggestion(entryPath, overlayName, entry, context);
      if (suggestion) context.suggestions.push(suggestion);
      continue;
    }
    visitDuplicates(entryPath, overlayName, entry.value, commonEntry.value, context);
  }
}

function visitBlock(path, entriesByOverlay, commonEntry, context) {
  const holders = context.overlayNames.filter((name) => entriesByOverlay.get(name));
  if (holders.length < 2 || holders.length * 2 <= context.overlayNames.length) return;
  const values = holders.map((name) => entriesByOverlay.get(name).value);
  if (values.some((value) => !value || value.kind !== 'map' || value.entries.length === 0)) return;
  const descendable = values.every((value) => !value.flow);
  if (commonEntry) {
    const commonValue = commonEntry.value;
    if (descendable && commonValue && commonValue.kind === 'map' && !commonValue.flow) {
      visitChildren(path, entriesByOverlay, commonValue, context);
    }
    return;
  }
  if (values.every((value) => value.shapeId === values[0].shapeId)) {
    const suggestion = moveSuggestion(path, holders, entriesByOverlay, context);
    if (suggestion) {
      context.suggestions.push(suggestion);
      return;
    }
  }
  if (descendable) visitChildren(path, entriesByOverlay, null, context);
}

function visitChildren(path, entriesByOverlay, commonNode, context) {
  const nodes = new Map(context.overlayNames.map((name) => {
    const entry = entriesByOverlay.get(name);
    return [name, entry ? entry.value : null];
  }));
  const keys = [];
  for (const node of nodes.values()) {
    if (!node || node.kind !== 'map' || node.flow) continue;
    for (const entry of node.entries) if (entry.key !== null && !keys.includes(entry.key)) keys.push(entry.key);
  }
  for (const key of keys) {
    const childPath = [...path, key];
    if (touchesLocals(childPath, context.localsKeys)) continue;
    const childEntries = new Map([...nodes].map(([name, node]) => [name, entryOf(node, key)]));
    visitBlock(childPath, childEntries, entryOf(commonNode, key), context);
  }
}

function commonLayerSuggestions(stack, schemaChecks) {
  const { dsl, files } = stack;
  const commonDoc = files.get(stack.common);
  const overlayNames = dsl.layers.overlayFolders.filter((name) => files.has(stack.overlays[name]));
  if (!commonDoc) return [];
  if (commonDoc.tree && (commonDoc.tree.kind !== 'map' || commonDoc.tree.flow)) return [];
  const scopeName = localsScopeName(dsl);
  const context = {
    stack,
    commonDoc,
    overlayNames,
    overlayDocs: new Map(overlayNames.map((name) => [name, files.get(stack.overlays[name])])),
    localsKeys: localsKeysOf(dsl),
    schemaChecks,
    schemaHashOf: (filePath) => {
      const schema = stack.schemas ? stack.schemas.get(filePath) : null;
      return schema ? schema.hash : null;
    },
    takenNames: new Set((stack.symbols || [])
      .filter((symbol) => symbol.scopeName === scopeName && typeof symbol.name === 'string')
      .map((symbol) => symbol.name)),
    suggestions: [],
  };
  for (const name of overlayNames) {
    visitDuplicates([], name, context.overlayDocs.get(name).tree, commonDoc.tree, context);
  }
  if (overlayNames.length >= 2) {
    const roots = new Map(overlayNames.map((name) => [name, { value: context.overlayDocs.get(name).tree }]));
    visitChildren([], roots, commonDoc.tree, context);
  }
  return context.suggestions;
}

function valueAt(value, path) {
  let node = value;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const members = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

function withLocals(value, localValuesByReference) {
  if (typeof value === 'string' && localValuesByReference.has(value)) return localValuesByReference.get(value);
  if (Array.isArray(value)) return value.map((item) => withLocals(item, localValuesByReference));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      withLocals(item, localValuesByReference),
    ]));
  }
  return value;
}

function foldsAgreeAfter(stack, suggestion, newTexts) {
  const localsKeys = localsKeysOf(stack.dsl) || [];
  const valueOf = (filePath, after) => {
    const doc = stack.files.get(filePath);
    if (!after || !newTexts.has(filePath)) return doc ? doc.value : null;
    return parseYaml(newTexts.get(filePath)).value;
  };
  const commonBefore = valueOf(stack.common, false);
  const commonAfter = valueOf(stack.common, true);
  for (const name of stack.dsl.layers.overlayFolders) {
    const overlayPath = stack.overlays[name];
    if (!stack.files.has(overlayPath)) continue;
    const overlayAfter = valueOf(overlayPath, true);
    const before = valueAt(deepMerge(commonBefore, valueOf(overlayPath, false)), suggestion.path);
    const localValuesByReference = new Map(suggestion.differences.map((difference) => {
      const declaredPath = [...localsKeys, difference.name];
      const own = valueAt(overlayAfter, declaredPath);
      return [difference.referenceText, own === undefined ? valueAt(commonAfter, declaredPath) : own];
    }));
    const after = withLocals(valueAt(deepMerge(commonAfter, overlayAfter), suggestion.path), localValuesByReference);
    const optedOut = suggestion.absent.includes(name) && before === undefined && canonicalJson(after) === '{}';
    if (!optedOut && canonicalJson(before) !== canonicalJson(after)) return false;
  }
  return true;
}

function editedTexts(stack, suggestion) {
  const texts = new Map();
  for (const [filePath, edits] of suggestion.edits) {
    texts.set(filePath, applyEdits(stack.files.get(filePath).text, edits));
  }
  return texts;
}

module.exports = {
  commonLayerSuggestions,
  foldsAgreeAfter,
  editedTexts,
  localReferenceText,
  canonicalJson,
};

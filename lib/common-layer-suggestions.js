const YAML = require('yaml');
const { analyzeDocument } = require('./analyze');
const { createNodeIds } = require('./node-ids');
const { deepMerge, isPlainObject } = require('./merge');
const { localsScopeName } = require('./local-values');
const {
  templateFor,
  fillTemplate,
  placeholderShapesOf,
  wrapInPlaceholder,
} = require('./reference-template');
const { WHOLE_SCALAR, WHOLE_PLACEHOLDER } = require('./reference-positions');
const { PATH_STEP_KINDS, pathMatches } = require('./document-path');
const { keySortOrderFor } = require('./key-sort-orders');
const {
  entryChain,
  deletionOf,
  entryReplacement,
  insertionUnder,
  localsInsertion,
  placementIn,
  sourceSpacingOf,
  blockLines,
  commentedBlockLines,
  keyCommentLines,
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
    && candidate.tokens.slice(0, -1).every((token) => token.kind === PATH_STEP_KINDS.name)
    && candidate.tokens[candidate.tokens.length - 1].kind === PATH_STEP_KINDS.wildcard);
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
  const [shape] = dsl.placeholder ? placeholderShapesOf(dsl.placeholder) : [];
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

function mapKeysInOrder(nodes) {
  const keys = [];
  for (const node of nodes) {
    for (const entry of node.entries) if (entry.key !== null && !keys.includes(entry.key)) keys.push(entry.key);
  }
  return keys;
}

function collectLeaves(nodesByHolder, relativePath, found) {
  const nodes = nodesByHolder.map(([, node]) => node);
  const everyHolderHolds = nodes.every((node) => node !== undefined);
  if (everyHolderHolds && nodes.every((node) => leafId(node) === leafId(nodes[0]))) {
    found.agreeing += 1;
    return;
  }
  if (everyHolderHolds && nodes.every((node) => node && node.kind === 'map')) {
    for (const key of mapKeysInOrder(nodes)) {
      const children = nodesByHolder.map(([holder, node]) => {
        const entry = node.entries.find((candidate) => candidate.key === key);
        return [holder, entry ? entry.value : undefined];
      });
      collectLeaves(children, [...relativePath, key], found);
    }
    return;
  }
  const itemCounts = new Set(nodes.map((node) => (node && node.kind === 'seq' ? node.items.length : -1)));
  if (everyHolderHolds && itemCounts.size === 1 && !itemCounts.has(-1)) {
    nodes[0].items.forEach((_, index) => {
      const items = nodesByHolder.map(([holder, node]) => [holder, node.items[index]]);
      collectLeaves(items, [...relativePath, index], found);
    });
    return;
  }
  found.differing.push({ relativePath, nodesByHolder });
}

function nameSegment(step) {
  const words = String(step).split(/\s+/).filter(Boolean);
  return (words[words.length - 1] || '').replace(/[^A-Za-z0-9_]/g, '_');
}

function declaresNameAt(dsl, documentPath) {
  return (dsl.declarations || []).some((rule) => rule.nameSource === 'key'
    && pathMatches(rule.tokens, documentPath, rule));
}

function namedKeyTextOf(step, documentPath, dsl) {
  if (typeof step !== 'string' || declaresNameAt(dsl, documentPath)) return null;
  const words = step.split(/\s+/).filter(Boolean);
  const markerFunction = dsl.function ? dsl.function.markerFunction : null;
  const callAt = markerFunction ? words.findIndex((word) => word.startsWith(markerFunction.callMarker)) : -1;
  const nameWords = callAt < 0 ? words : words.slice(0, callAt);
  return nameWords.length > 0 ? nameSegment(nameWords.join(' ')) : null;
}

function localNameCandidates(path, relativePath, dsl) {
  const blockKey = nameSegment(path[path.length - 1]);
  const namedKeys = relativePath
    .map((step, index) => namedKeyTextOf(step, [...path, ...relativePath.slice(0, index + 1)], dsl))
    .filter(Boolean);
  const candidates = [];
  for (let keysKept = Math.min(1, namedKeys.length); keysKept <= namedKeys.length; keysKept += 1) {
    candidates.push([blockKey, ...namedKeys.slice(namedKeys.length - keysKept)]);
  }
  for (let ancestors = 1; ancestors < path.length; ancestors += 1) {
    const ancestorKeys = path.slice(path.length - 1 - ancestors, path.length - 1).map(nameSegment);
    candidates.push([...ancestorKeys, blockKey, ...namedKeys]);
  }
  return candidates.map((segments) => segments.join('_'));
}

function localNameFor(path, relativePath, takenNames, reservedNames, dsl) {
  return localNameCandidates(path, relativePath, dsl)
    .find((name) => !takenNames.has(name) && !reservedNames.has(name)) || null;
}

function suggestionMarkOf(doc, entry) {
  const lineStart = doc.text.lastIndexOf('\n', entry.keyStart - 1) + 1;
  const newline = doc.text.indexOf('\n', entry.keyStart);
  const lineEnd = newline < 0 ? doc.text.length : newline;
  const position = { line: entry.keyRange.start.line, character: lineEnd - lineStart };
  return {
    file: doc.filePath,
    range: { start: position, end: { ...position } },
    scope: { start: { line: position.line, character: 0 }, end: { line: lastLineOf(doc, entry), character: 0 } },
  };
}

function lastLineOf(doc, entry) {
  const valueEnd = entry.value ? entry.value.end : entry.keyEnd;
  const lastCharacter = doc.text.slice(0, valueEnd).trimEnd().length;
  return doc.text.slice(0, lastCharacter).split('\n').length - 1;
}

const EMPTY_VALUE_TEXT_BY_TYPE = { string: '""', number: '0', boolean: 'false' };
const EMPTY_VALUE_TEXT_BY_KIND = { seq: '[]', map: '{}' };

function emptyValueTextOf(nodes) {
  const kinds = new Set(nodes.map((node) => node.kind));
  if (kinds.size !== 1) return null;
  const [kind] = kinds;
  if (Object.hasOwn(EMPTY_VALUE_TEXT_BY_KIND, kind)) return EMPTY_VALUE_TEXT_BY_KIND[kind];
  const types = new Set(nodes.map((node) => (node.value === null ? 'null' : typeof node.value)));
  if (types.size !== 1) return null;
  const [type] = types;
  return Object.hasOwn(EMPTY_VALUE_TEXT_BY_TYPE, type) ? EMPTY_VALUE_TEXT_BY_TYPE[type] : null;
}

function isEmptyCollection(node) {
  return (node.kind === 'map' && node.entries.length === 0) || (node.kind === 'seq' && node.items.length === 0);
}

function isBlockCollection(node) {
  return (node.kind === 'seq' || node.kind === 'map') && !node.flow;
}

function localValueText(doc, node) {
  const text = doc.text.slice(node.start, node.end).replace(/\s+$/, '');
  if (!text.includes('\n')) return text;
  const column = node.start - (doc.text.lastIndexOf('\n', node.start - 1) + 1);
  const [firstLine, ...laterLines] = text.split('\n');
  const shiftedLines = [];
  for (const line of laterLines) {
    if (line.trim() === '') {
      shiftedLines.push('');
      continue;
    }
    if (line.match(/^ */)[0].length < column) return null;
    shiftedLines.push(line.slice(column));
  }
  return [firstLine, ...shiftedLines].join('\n');
}

function schemaDefaultText(documentPath, overlay, context) {
  const check = context.nodeCheckIn(overlay, documentPath);
  const stated = check.defaultValue();
  if (!stated || stated.value === null || typeof stated.value === 'object') return null;
  return YAML.stringify(stated.value).trimEnd();
}

function optOutTextFor(heldNodes, documentPath, overlay, context) {
  const kinds = new Set(heldNodes.map((node) => node.kind));
  if (kinds.size !== 1) return null;
  const [kind] = kinds;
  if (Object.hasOwn(EMPTY_VALUE_TEXT_BY_KIND, kind)) return EMPTY_VALUE_TEXT_BY_KIND[kind];
  return schemaDefaultText(documentPath, overlay, context);
}

function differenceOf(path, leaf, context, reservedNames) {
  const held = leaf.nodesByHolder.filter(([, node]) => node !== undefined);
  if (held.some(([, node]) => holdsNull(node))) return null;
  const heldNodes = held.map(([, node]) => node);
  const valuesByHolder = new Map();
  for (const [holder, node] of held) {
    const text = localValueText(context.overlayDocs.get(holder), node);
    if (text === null) return null;
    valuesByHolder.set(holder, { id: leafId(node), text, blockStyle: isBlockCollection(node) });
  }
  const lacking = leaf.nodesByHolder.filter(([, node]) => node === undefined).map(([holder]) => holder);
  for (const holder of lacking) {
    const text = optOutTextFor(heldNodes, [...path, ...leaf.relativePath], holder, context);
    if (text === null) return null;
    valuesByHolder.set(holder, { id: `opt-out ${text}`, text, blockStyle: false });
  }
  const name = localNameFor(path, leaf.relativePath, context.takenNames, reservedNames, context.stack.dsl);
  const referenceText = name ? localReferenceText(context.stack.dsl, name) : null;
  if (!referenceText) return null;
  reservedNames.add(name);
  const groups = [];
  for (const [holder] of leaf.nodesByHolder) {
    const { id, text, blockStyle } = valuesByHolder.get(holder);
    const group = groups.find((candidate) => candidate.id === id);
    if (group) group.overlays.push(holder);
    else groups.push({ id, text, blockStyle, overlays: [holder] });
  }
  const mostOverlays = Math.max(...groups.map((group) => group.overlays.length));
  const largestGroups = groups.filter((group) => group.overlays.length === mostOverlays);
  const commonGroup = largestGroups.length === 1 ? largestGroups[0] : null;
  const commonValueText = commonGroup ? commonGroup.text : emptyValueTextOf(heldNodes);
  const commonBlockStyle = commonGroup ? commonGroup.blockStyle : false;
  if (commonValueText === null) return null;
  return { name, referenceText, leaf, groups, commonGroup, commonValueText, commonBlockStyle, lacking };
}

function differencesOf(path, found, context) {
  if (found.differing.length === 0) return [];
  if (!context.localsKeys || touchesLocals(path, context.localsKeys) || found.agreeing === 0) return null;
  const reservedNames = new Set();
  const differences = [];
  for (const leaf of found.differing) {
    const difference = differenceOf(path, leaf, context, reservedNames);
    if (!difference) return null;
    differences.push(difference);
  }
  return differences;
}

function referenceReplacement(text, node, referenceText) {
  let end = node.end;
  while (end > node.start && /\s/.test(text[end - 1])) end -= 1;
  let before = node.start;
  while (before > 0 && /\s/.test(text[before - 1])) before -= 1;
  if (text[before - 1] === ':' && text.slice(before, node.start).includes('\n')) {
    return { start: before, end, text: ` ${referenceText}` };
  }
  return { start: node.start, end, text: referenceText };
}

function keyTextsOf(doc, path) {
  return entryChain(doc.tree, path).map((entry) => doc.text.slice(entry.keyStart, entry.keyEnd));
}

function keysAt(doc, mapPath) {
  const map = mapPath.length === 0
    ? doc.tree
    : (entryChain(doc.tree, mapPath)[mapPath.length - 1] || {}).value;
  return map && map.kind === 'map' ? map.entries.map((entry) => entry.key) : [];
}

function placementsFrom(sourceDocs, dsl) {
  return (parentMap, parentPath, newKey) => {
    const keySortOrder = keySortOrderFor(dsl, parentPath);
    if (!keySortOrder) return null;
    const placement = placementIn(parentMap, newKey, keySortOrder, sourceDocs.map((doc) => keysAt(doc, parentPath)));
    return { ...placement, spacing: sourceSpacingOf(sourceDocs, [...parentPath, newKey]) };
  };
}

function moveEdits(path, holders, absent, differences, context) {
  const { commonDoc, overlayDocs, localsKeys, stack } = context;
  const sourceHolder = holders
    .find((holder) => differences.every((difference) => !difference.lacking.includes(holder)));
  const sourceDoc = overlayDocs.get(sourceHolder);
  const sourceEntries = entryChain(sourceDoc.tree, path);
  const sourceEntry = sourceEntries[path.length - 1];
  const keyTexts = keyTextsOf(sourceDoc, path);
  const placementFor = placementsFrom(holders.map((holder) => context.placementSourceDocs.get(holder)), stack.dsl);
  const replacements = differences.map((difference) => {
    const [, node] = difference.leaf.nodesByHolder.find(([holder]) => holder === sourceHolder);
    return referenceReplacement(sourceDoc.text, node, difference.referenceText);
  });
  const editsByFile = new Map();
  const add = (filePath, ...edits) => {
    if (!editsByFile.has(filePath)) editsByFile.set(filePath, []);
    editsByFile.get(filePath).push(...edits);
  };
  const localsKeyTexts = localsKeys || [];
  const commonLocals = localsInsertion(commonDoc, localsKeyTexts, localsKeyTexts, differences.map((difference) => ({
    name: difference.name,
    valueText: difference.commonValueText,
    blockStyle: difference.commonBlockStyle,
  })), placementFor);
  if (!commonLocals) return null;
  add(stack.common, ...commonLocals);
  const block = insertionUnder(
    commonDoc,
    path,
    keyTexts,
    (indent) => commentedBlockLines(sourceDoc, sourceEntry, replacements, indent),
    placementFor,
    (index, indent) => keyCommentLines(sourceDoc, sourceEntries[index], indent),
  );
  if (!block) return null;
  add(stack.common, block);
  for (const holder of holders) {
    const doc = overlayDocs.get(holder);
    const deletion = deletionOf(doc, path);
    if (!deletion) return null;
    add(doc.filePath, deletion);
    const own = differences
      .filter((difference) => !difference.commonGroup || !difference.commonGroup.overlays.includes(holder))
      .map((difference) => {
        const group = difference.groups.find((candidate) => candidate.overlays.includes(holder));
        return { name: difference.name, valueText: group.text, blockStyle: group.blockStyle };
      });
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
  return normalizedFiles(editsByFile, context);
}

function textOfLayer(stack, filePath) {
  const doc = stack.files.get(filePath);
  return doc ? doc.text : '';
}

function commonLayerSeedText(overlayDocs, skipKeys) {
  const lines = [];
  for (const key of skipKeys) {
    const entries = overlayDocs.map((doc) => entryOf(doc.tree, key));
    if (entries.some((entry) => !entry || !entry.value || entry.value.id !== entries[0].value.id)) continue;
    const copied = blockLines(overlayDocs[0], entries[0], [], 0);
    if (copied) lines.push(...copied);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function normalizedFiles(editsByFile, context) {
  const normalized = new Map();
  for (const [filePath, edits] of editsByFile) {
    const createsCommonLayer = context.commonLayerMissing && filePath === context.stack.common;
    const seed = createsCommonLayer && context.commonLayerSeed
      ? [{ start: 0, end: 0, text: context.commonLayerSeed }]
      : [];
    const merged = normalizedEdits(textOfLayer(context.stack, filePath), [...seed, ...edits]);
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
    differencePaths: details.differencePaths || [],
    optOuts: details.optOuts || [],
    keepsCommonValue: details.keepsCommonValue,
    keepsOwnValue: details.keepsOwnValue,
    createsCommonLayer: context.commonLayerMissing
      || (Boolean(context.stack.commonLayerTextFrom) && kind !== 'delete'),
    schemaGroups: details.schemaGroups,
    optOutFailures: details.optOutFailures,
    optOutConditionalFields: details.optOutConditionalFields,
    marks: holders.map((name) => suggestionMarkOf(context.overlayDocs.get(name), entriesByOverlay.get(name))),
    edits: details.edits,
  };
}

function schemaGroupsOf(path, context) {
  const groups = [];
  for (const name of context.overlayNames) {
    const check = context.nodeCheckIn(name, path);
    const group = groups.find((candidate) => candidate.check.sameNodeAs(check));
    if (group) group.overlays.push(name);
    else groups.push({ check, overlays: [name] });
  }
  return groups;
}

function optOutChecksOf(path, optOuts, context) {
  return optOuts.map((optOut) => ({
    optOut,
    check: context.nodeCheckIn(optOut.overlay, [...path, ...optOut.relativePath]),
  }));
}

function optOutFailuresOf(optOutChecks) {
  return optOutChecks
    .map(({ optOut, check }) => ({
      overlay: optOut.overlay,
      valueText: optOut.valueText,
      failures: check.optOutFailures(YAML.parse(optOut.valueText)),
    }))
    .filter((failed) => failed.failures.length > 0);
}

function optOutConditionalFieldsOf(optOutChecks) {
  return optOutChecks
    .filter(({ optOut }) => optOut.valueText === EMPTY_VALUE_TEXT_BY_KIND.map)
    .map(({ optOut, check }) => ({ overlay: optOut.overlay, fields: check.conditionallyRequiredFields() }))
    .filter((conditional) => conditional.fields.length > 0);
}

function checkedMoveRecord(path, holders, entriesByOverlay, details, context) {
  const groups = schemaGroupsOf(path, context);
  const schemaGroups = groups.length > 1
    ? groups.map((group) => ({ overlays: group.overlays, state: group.check.state }))
    : [];
  const optOutChecks = schemaGroups.length > 0 ? [] : optOutChecksOf(path, details.optOuts, context);
  const optOutFailures = optOutFailuresOf(optOutChecks);
  if (schemaGroups.length > 0 || optOutFailures.length > 0) {
    const potentialDetails = {
      ...details,
      differences: [],
      schemaGroups,
      optOutFailures,
      optOutConditionalFields: [],
      edits: new Map(),
    };
    return suggestionRecord('potential_move', path, holders, entriesByOverlay, potentialDetails, context);
  }
  for (const difference of details.differences) context.takenNames.add(difference.name);
  const optOutConditionalFields = optOutConditionalFieldsOf(optOutChecks);
  const moveDetails = { ...details, schemaGroups, optOutFailures, optOutConditionalFields };
  return suggestionRecord('move', path, holders, entriesByOverlay, moveDetails, context);
}

const MOST_DIFFERENCES_PER_MOVE = 1;

function mapUnitSuggestion(path, ownEntries, context) {
  const holders = context.overlayNames.filter((name) => ownEntries.get(name));
  if (holders.length < 2 || holders.length * 2 <= context.overlayNames.length) return null;
  const values = holders.map((name) => ownEntries.get(name).value);
  if (values.some((value) => value.entries.length === 0)) return null;
  const absent = context.overlayNames.filter((name) => !holders.includes(name));
  const found = { agreeing: 0, differing: [] };
  collectLeaves(holders.map((name, index) => [name, values[index]]), [], found);
  if (found.differing.length + (absent.length > 0 ? 1 : 0) > MOST_DIFFERENCES_PER_MOVE) return null;
  const differences = differencesOf(path, found, context);
  if (differences === null) return null;
  const edits = moveEdits(path, holders, absent, differences, context);
  if (!edits) return null;
  const optOuts = [
    ...absent.map((overlay) => ({ overlay, relativePath: [], valueText: EMPTY_VALUE_TEXT_BY_KIND.map })),
    ...differences.flatMap((difference) => difference.lacking.map((overlay) => ({
      overlay,
      relativePath: difference.leaf.relativePath,
      valueText: difference.groups.find((group) => group.overlays.includes(overlay)).text,
    }))),
  ];
  const differencePaths = [
    ...differences.map((difference) => [...path, ...difference.leaf.relativePath]),
    ...(absent.length > 0 ? [path] : []),
  ];
  const details = { absent, differences, edits, keepsCommonValue: [], keepsOwnValue: [], optOuts, differencePaths };
  return checkedMoveRecord(path, holders, ownEntries, details, context);
}

function isBlockMap(node) {
  return Boolean(node) && node.kind === 'map' && !node.flow;
}

function repeatedValueHolders(ownEntries, commonValue, context) {
  const overlaysByValueId = new Map();
  for (const name of context.overlayNames) {
    const own = ownEntries.get(name);
    const effective = own ? own.value : commonValue;
    if (!effective) continue;
    if (!overlaysByValueId.has(effective.id)) overlaysByValueId.set(effective.id, []);
    overlaysByValueId.get(effective.id).push(name);
  }
  const groups = [...overlaysByValueId].filter(([id]) => !commonValue || id !== commonValue.id);
  const mostOverlays = Math.max(0, ...groups.map(([, names]) => names.length));
  const largest = groups.filter(([, names]) => names.length === mostOverlays);
  if (largest.length !== 1 || mostOverlays < 2 || mostOverlays * 2 <= context.overlayNames.length) return null;
  return largest[0][1];
}

function repeatedValueEdits(path, holders, ownEntries, commonEntry, others, context) {
  const { commonDoc, overlayDocs, stack } = context;
  const sourceDoc = overlayDocs.get(holders[0]);
  const sourceEntry = ownEntries.get(holders[0]);
  const keyTexts = keyTextsOf(sourceDoc, path);
  const placementFor = placementsFrom(holders.map((holder) => context.placementSourceDocs.get(holder)), stack.dsl);
  const editsByFile = new Map();
  const add = (filePath, edit) => {
    if (!edit) return false;
    if (!editsByFile.has(filePath)) editsByFile.set(filePath, []);
    editsByFile.get(filePath).push(edit);
    return true;
  };
  const sourceEntries = entryChain(sourceDoc.tree, path);
  const sourceLines = (indent) => commentedBlockLines(sourceDoc, sourceEntry, [], indent);
  const openedKeyCommentLines = (index, indent) => keyCommentLines(sourceDoc, sourceEntries[index], indent);
  const commonEdit = commonEntry
    ? entryReplacement(commonDoc, path, sourceLines)
    : insertionUnder(commonDoc, path, keyTexts, sourceLines, placementFor, openedKeyCommentLines);
  if (!add(stack.common, commonEdit)) return null;
  for (const holder of holders) {
    const doc = overlayDocs.get(holder);
    if (!add(doc.filePath, deletionOf(doc, path))) return null;
  }
  for (const name of others.keepsCommonValue) {
    const doc = overlayDocs.get(name);
    const commonLines = (indent) => commentedBlockLines(commonDoc, commonEntry, [], indent);
    if (!add(doc.filePath, insertionUnder(doc, path, keyTexts, commonLines, placementFor))) return null;
  }
  for (const name of others.absent) {
    const doc = overlayDocs.get(name);
    const optOutLines = (indent) => [`${' '.repeat(indent)}${keyTexts[path.length - 1]}: ${others.optOutText}`];
    if (!add(doc.filePath, insertionUnder(doc, path, keyTexts, optOutLines, placementFor))) return null;
  }
  return normalizedFiles(editsByFile, context);
}

function valueUnitSuggestion(path, ownEntries, commonEntry, context) {
  const commonValue = commonEntry ? commonEntry.value : null;
  const holders = repeatedValueHolders(ownEntries, commonValue, context);
  if (!holders) return null;
  const { value } = ownEntries.get(holders[0]);
  if (isEmptyCollection(value)) return null;
  if (value.kind === 'map' && commonValue && commonValue.kind === 'map') return null;
  if (!commonEntry && isBlockMap(value) && !touchesLocals(path, context.localsKeys)) return null;
  const others = context.overlayNames.filter((name) => !holders.includes(name));
  const absent = others.filter((name) => !ownEntries.get(name) && !commonEntry);
  const keepsCommonValue = others.filter((name) => !ownEntries.get(name) && commonEntry);
  const keepsOwnValue = others.filter((name) => ownEntries.get(name));
  if (value.kind === 'map' && keepsOwnValue.some((name) => ownEntries.get(name).value.kind === 'map')) return null;
  const optOutText = absent.length > 0 ? optOutTextFor([value], path, absent[0], context) : null;
  if (absent.length > 0 && optOutText === null) return null;
  const edits = repeatedValueEdits(path, holders, ownEntries, commonEntry, {
    absent,
    keepsCommonValue,
    optOutText,
  }, context);
  if (!edits) return null;
  const details = {
    absent,
    differences: [],
    edits,
    keepsCommonValue,
    keepsOwnValue,
    optOuts: absent.map((overlay) => ({ overlay, relativePath: [], valueText: optOutText })),
    differencePaths: others.length > 0 ? [path] : [],
  };
  return checkedMoveRecord(path, holders, ownEntries, details, context);
}

function unitSuggestion(path, ownEntries, commonEntry, context) {
  const ownValues = [...ownEntries.values()].filter(Boolean).map((entry) => entry.value);
  if (ownValues.some(holdsNull) || (commonEntry && holdsNull(commonEntry.value))) return null;
  const allBlockMaps = ownValues.every(isBlockMap);
  if (commonEntry) {
    if (allBlockMaps && isBlockMap(commonEntry.value)) return null;
    return valueUnitSuggestion(path, ownEntries, commonEntry, context);
  }
  return allBlockMaps
    ? mapUnitSuggestion(path, ownEntries, context)
    : valueUnitSuggestion(path, ownEntries, null, context);
}

function duplicateSuggestion(path, overlayName, entry, context) {
  const doc = context.overlayDocs.get(overlayName);
  const deletion = deletionOf(doc, path);
  if (!deletion) return null;
  const entriesByOverlay = new Map([[overlayName, entry]]);
  const details = {
    absent: [],
    differences: [],
    keepsCommonValue: [],
    keepsOwnValue: [],
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

function duplicateCheckDepthOf(duplicateCheck, path) {
  return Object.hasOwn(duplicateCheck.keyDepths, path[0]) ? duplicateCheck.keyDepths[path[0]] : duplicateCheck.depth;
}

function onMergePoint(path, mergePoint) {
  return path.length <= mergePoint.length && path.every((step, index) => step === mergePoint[index]);
}

function mergePointEntryOf(commonNode, path, mergePoint) {
  if (!onMergePoint(path, mergePoint) || !commonNode || commonNode.kind !== 'map') return null;
  return commonNode.entries.find((entry) => entry.key === path[path.length - 1]) || null;
}

function visitDuplicates(path, overlayName, overlayNode, commonNode, context) {
  const { duplicateCheck } = context.stack.dsl.layers;
  const mergePoint = context.stack.mergePoint || [];
  if (!overlayNode || overlayNode.kind !== 'map' || overlayNode.flow) return;
  for (const entry of overlayNode.entries) {
    if (duplicateCheck.skipKeys.includes(entry.key)) continue;
    const entryPath = [...path, entry.key];
    if (entryPath.length <= mergePoint.length) {
      const pathEntry = mergePointEntryOf(commonNode, entryPath, mergePoint);
      if (pathEntry) visitDuplicates(entryPath, overlayName, entry.value, pathEntry.value, context);
      continue;
    }
    if (entryPath.length > duplicateCheckDepthOf(duplicateCheck, entryPath)) continue;
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

function visitUnits(path, ownNodes, commonNode, context) {
  const { duplicateCheck } = context.stack.dsl.layers;
  const mergePoint = context.stack.mergePoint || [];
  for (const key of mapKeysInOrder([...ownNodes.values()].filter(isBlockMap))) {
    if (duplicateCheck.skipKeys.includes(key)) continue;
    const childPath = [...path, key];
    const ownEntries = new Map([...ownNodes].map(([name, node]) => [name, entryOf(node, key)]));
    if (childPath.length <= mergePoint.length) {
      const pathEntry = mergePointEntryOf(commonNode, childPath, mergePoint);
      if (!pathEntry) continue;
      const childNodes = new Map([...ownEntries].map(([name, entry]) => [name, entry ? entry.value : null]));
      visitUnits(childPath, childNodes, pathEntry.value, context);
      continue;
    }
    const commonEntry = entryOf(commonNode, key);
    const childValues = [...ownEntries.values()].filter(Boolean).map((entry) => entry.value);
    const descends = childPath.length < duplicateCheckDepthOf(duplicateCheck, childPath)
      && childValues.every(isBlockMap)
      && (!commonEntry || isBlockMap(commonEntry.value));
    if (descends) {
      const childNodes = new Map([...ownEntries].map(([name, entry]) => [name, entry ? entry.value : null]));
      visitUnits(childPath, childNodes, commonEntry ? commonEntry.value : null, context);
      continue;
    }
    const suggestion = unitSuggestion(childPath, ownEntries, commonEntry, context);
    if (suggestion) context.suggestions.push(suggestion);
  }
}

function parentPathOf(path) {
  return path.slice(0, -1);
}

function combinesWithNeighbors(suggestion) {
  return suggestion.kind === 'move' && suggestion.optOutConditionalFields.length === 0;
}

function neighborGroupKeyOf(suggestion) {
  return JSON.stringify([
    parentPathOf(suggestion.path),
    suggestion.holders,
    suggestion.absent,
    suggestion.keepsCommonValue,
    suggestion.keepsOwnValue,
  ]);
}

function keyIndexIn(doc, path) {
  return keysAt(doc, parentPathOf(path)).indexOf(path[path.length - 1]);
}

function combinedMoveRecord(members) {
  const [first] = members;
  const last = members[members.length - 1];
  const memberPaths = members.map((member) => member.path);
  return {
    ...first,
    id: JSON.stringify(['move', first.holders, memberPaths]),
    memberPaths,
    differences: members.flatMap((member) => member.differences),
    differencePaths: members.flatMap((member) => member.differencePaths),
    optOuts: members.flatMap((member) => member.optOuts),
    marks: first.marks.map((mark, index) => ({
      ...mark,
      scope: { start: mark.scope.start, end: last.marks[index].scope.end },
    })),
    edits: null,
  };
}

function neighborRunsOf(members, overlayDocs) {
  const firstDoc = overlayDocs.get(members[0].holders[0]);
  const ordered = [...members]
    .sort((left, right) => keyIndexIn(firstDoc, left.path) - keyIndexIn(firstDoc, right.path));
  const differenceCountOf = (run) => run.reduce((count, member) => count + member.differencePaths.length, 0);
  const runs = [[ordered[0]]];
  for (const next of ordered.slice(1)) {
    const run = runs[runs.length - 1];
    const previous = run[run.length - 1];
    const follows = next.holders.every((holder) => {
      const doc = overlayDocs.get(holder);
      return keyIndexIn(doc, next.path) === keyIndexIn(doc, previous.path) + 1;
    });
    const withinDifferences = differenceCountOf(run) + next.differencePaths.length <= MOST_DIFFERENCES_PER_MOVE;
    if (follows && withinDifferences) run.push(next);
    else runs.push([next]);
  }
  return runs;
}

function combinedNeighborMoves(suggestions, overlayDocs) {
  const groups = new Map();
  for (const suggestion of suggestions.filter(combinesWithNeighbors)) {
    const groupKey = neighborGroupKeyOf(suggestion);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(suggestion);
  }
  const replacements = new Map();
  for (const members of groups.values()) {
    for (const run of neighborRunsOf(members, overlayDocs)) {
      if (run.length < 2) continue;
      run.forEach((member, index) => replacements.set(member, index === 0 ? combinedMoveRecord(run) : null));
    }
  }
  return suggestions.flatMap((suggestion) => {
    if (!replacements.has(suggestion)) return [suggestion];
    return replacements.get(suggestion) ? [replacements.get(suggestion)] : [];
  });
}

function commonLayerSuggestions(stack, schemaChecks) {
  const found = suggestionsOfEachBlock(stack, schemaChecks);
  return found.overlayDocs ? combinedNeighborMoves(found.suggestions, found.overlayDocs) : found.suggestions;
}

function layerPathsOf(stack) {
  return [stack.common, ...stack.overlayNames.map((name) => stack.overlays[name])];
}

function layerDocOf(stack, filePath, text, nodeIds = createNodeIds()) {
  return stack.layerDocOfText
    ? stack.layerDocOfText(filePath, text, nodeIds)
    : analyzeDocument(text, filePath, stack.dsl, nodeIds);
}

function stackWithTexts(stack, texts) {
  const nodeIds = createNodeIds();
  const files = new Map();
  for (const filePath of layerPathsOf(stack)) {
    const text = texts.has(filePath) ? texts.get(filePath) : textOfLayer(stack, filePath);
    if (texts.has(filePath) || stack.files.has(filePath)) {
      files.set(filePath, layerDocOf(stack, filePath, text, nodeIds));
    }
  }
  return { ...stack, files, symbols: [...files.values()].flatMap((doc) => doc.symbols) };
}

function changedSpanEdit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) };
}

function combinedMoveEdits(stack, suggestion, schemaChecks) {
  let current = stack;
  for (const memberPath of suggestion.memberPaths) {
    const member = suggestionsOfEachBlock(current, schemaChecks, stack).suggestions
      .find((candidate) => candidate.kind === 'move' && canonicalJson(candidate.path) === canonicalJson(memberPath));
    if (!member) return null;
    const texts = editedTexts(current, member);
    if (!foldsAgreeAfter(current, member, texts)) return null;
    current = stackWithTexts(current, texts);
  }
  const edits = new Map();
  for (const filePath of layerPathsOf(stack)) {
    if (!current.files.has(filePath)) continue;
    const before = textOfLayer(stack, filePath);
    const after = current.files.get(filePath).text;
    if (after !== before) edits.set(filePath, [changedSpanEdit(before, after)]);
  }
  return edits;
}

function suggestionsOfEachBlock(stack, schemaChecks, placementSourceStack = stack) {
  const { dsl, files } = stack;
  const commonLayerMissing = !files.has(stack.common);
  const commonDoc = commonLayerMissing
    ? analyzeDocument('', stack.common, dsl, createNodeIds())
    : files.get(stack.common);
  const overlayNames = stack.overlayNames.filter((name) => files.has(stack.overlays[name]));
  const mergePoint = stack.mergePoint || [];
  const rootChain = entryChain(commonDoc.tree, mergePoint);
  let commonRoot = null;
  if (mergePoint.length === 0) commonRoot = commonDoc.tree;
  else if (rootChain.length === mergePoint.length) commonRoot = rootChain[rootChain.length - 1].value;
  if (commonDoc.tree && (!commonRoot || commonRoot.kind !== 'map' || commonRoot.flow)) {
    return { suggestions: [], overlayDocs: null };
  }
  const scopeName = localsScopeName(dsl);
  const overlayDocs = new Map(overlayNames.map((name) => [name, files.get(stack.overlays[name])]));
  const context = {
    stack,
    commonDoc,
    commonLayerMissing,
    commonLayerSeed: commonLayerMissing
      ? commonLayerSeedText([...overlayDocs.values()], dsl.layers.duplicateCheck.skipKeys)
      : '',
    overlayNames,
    overlayDocs,
    placementSourceDocs: new Map(overlayNames.map((name) => [
      name,
      placementSourceStack.files.get(stack.overlays[name]) || overlayDocs.get(name),
    ])),
    localsKeys: localsKeysOf(dsl),
    schemaChecks,
    nodeCheckIn: (overlayName, documentPath) => {
      const schema = stack.schemas ? stack.schemas.get(stack.overlays[overlayName]) : null;
      return schemaChecks.nodeCheck(schema ? schema.hash : null, documentPath);
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
    const rootNodes = new Map(overlayNames.map((name) => [name, context.overlayDocs.get(name).tree]));
    visitUnits([], rootNodes, commonDoc.tree, context);
  }
  return { suggestions: context.suggestions, overlayDocs };
}

function valueAt(value, path) {
  let node = value;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function withValueAt(value, relativePath, replacement) {
  if (relativePath.length === 0) return replacement;
  const [step, ...laterSteps] = relativePath;
  const container = Array.isArray(value) ? [...value] : { ...(isPlainObject(value) ? value : {}) };
  container[step] = withValueAt(container[step], laterSteps, replacement);
  return container;
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
    return layerDocOf(stack, filePath, newTexts.get(filePath)).value;
  };
  const commonBefore = valueOf(stack.common, false);
  const commonAfter = valueOf(stack.common, true);
  for (const name of stack.overlayNames) {
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
    const expected = (suggestion.optOuts || [])
      .filter((optOut) => optOut.overlay === name)
      .reduce((value, optOut) => withValueAt(value, optOut.relativePath, YAML.parse(optOut.valueText)), before);
    if (canonicalJson(expected) !== canonicalJson(after)) return false;
  }
  return true;
}

function editedTexts(stack, suggestion) {
  const texts = new Map();
  for (const [filePath, edits] of suggestion.edits) {
    texts.set(filePath, applyEdits(textOfLayer(stack, filePath), edits));
  }
  return texts;
}

module.exports = {
  commonLayerSuggestions,
  commonLayerSeedText,
  combinedMoveEdits,
  foldsAgreeAfter,
  editedTexts,
  localReferenceText,
  canonicalJson,
};

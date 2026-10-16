const YAML = require('yaml');
const { rangeBetween } = require('./range');
const { createNodeIds } = require('./node-ids');
const { keyOfTag } = require('./tag-keys');

const UNFINISHED_KEY_LINE = /^(\s*)((?:-\s+)?)([^\s:#'"{}[\],&*!|>%@`-][^\s:#'"{}[\],]*)\s*$/;
const UNFINISHED_KEY_ERROR_CODES = new Set(['MULTILINE_IMPLICIT_KEY', 'MISSING_CHAR']);
const DUPLICATE_KEY_ERROR_CODE = 'DUPLICATE_KEY';

function errorRange(text, err) {
  const [errorStart, errorEnd] = err.pos;
  const start = Math.max(0, Math.min(errorStart, text.length));
  return rangeBetween(text, start, Math.max(start, Math.min(errorEnd, text.length)));
}

function valueIds(node, context) {
  return node ? { id: node.id, shapeId: node.shapeId } : context.nodeIds.scalarIds(null);
}

function convertUntagged(node, text, seen, context) {
  const start = node.range ? node.range[0] : 0;
  const end = node.range ? node.range[1] : start;
  const span = { start, end, range: rangeBetween(text, start, end) };
  context.nodeCount += 1;
  if (YAML.isMap(node)) {
    const entries = node.items.map((pair) => {
      const keyNode = pair.key;
      const rawKey = keyNode && Object.prototype.hasOwnProperty.call(keyNode, 'value') ? keyNode.value : null;
      const keyStart = keyNode && keyNode.range ? keyNode.range[0] : start;
      const keyEnd = keyNode && keyNode.range ? keyNode.range[1] : keyStart;
      return {
        key: typeof rawKey === 'string' || typeof rawKey === 'number' ? String(rawKey) : null,
        keyStart,
        keyEnd,
        keyRange: rangeBetween(text, keyStart, keyEnd),
        value: convert(pair.value, text, seen, context),
      };
    });
    const ids = context.nodeIds.mapIds(entries.map((entry) => ({
      key: entry.key,
      ...valueIds(entry.value, context),
    })));
    return { kind: 'map', ...span, ...ids, flow: Boolean(node.flow), entries };
  }
  if (YAML.isSeq(node)) {
    const items = node.items.map((item) => convert(item, text, seen, context));
    const ids = context.nodeIds.listIds(items.map((item) => valueIds(item, context)));
    return { kind: 'seq', ...span, ...ids, flow: Boolean(node.flow), items };
  }
  if (YAML.isScalar(node)) {
    return { kind: 'scalar', ...span, ...context.nodeIds.scalarIds(node.value), value: node.value };
  }
  return null;
}

function tagExpandedMap(tag, key, value, text, context) {
  const writtenTagStart = text.lastIndexOf(tag, value.start - 1);
  const keyStart = writtenTagStart === -1 ? value.start : writtenTagStart;
  const keyEnd = writtenTagStart === -1 ? value.start : keyStart + tag.length;
  const entries = [{ key, keyStart, keyEnd, keyRange: rangeBetween(text, keyStart, keyEnd), value }];
  const ids = context.nodeIds.mapIds([{ key, ...valueIds(value, context) }]);
  context.nodeCount += 1;
  return {
    kind: 'map',
    start: keyStart,
    end: value.end,
    range: rangeBetween(text, keyStart, value.end),
    ...ids,
    flow: true,
    entries,
  };
}

function convert(node, text, seen, context) {
  if (!node || typeof node !== 'object') return null;
  if (YAML.isAlias && YAML.isAlias(node)) {
    const resolved = typeof node.resolve === 'function' ? node.resolve(context.doc) : null;
    return convert(resolved, text, seen, context);
  }
  if (seen.has(node)) return null;
  seen.add(node);
  try {
    const converted = convertUntagged(node, text, seen, context);
    const tagKey = converted ? keyOfTag(context.tagKeys, node.tag) : null;
    return tagKey === null ? converted : tagExpandedMap(node.tag, tagKey, converted, text, context);
  } finally {
    seen.delete(node);
  }
}

function plainValueOf(node) {
  if (!node) return null;
  if (node.kind === 'map') {
    return Object.fromEntries(node.entries
      .filter((entry) => entry.key !== null)
      .map((entry) => [entry.key, plainValueOf(entry.value)]));
  }
  if (node.kind === 'seq') return node.items.map(plainValueOf);
  return node.value;
}

function unfinishedKeyAt(source, err) {
  if (!UNFINISHED_KEY_ERROR_CODES.has(err.code)) return null;
  const lineStart = source.lastIndexOf('\n', err.pos[0] - 1) + 1;
  const lineBreak = source.indexOf('\n', lineStart);
  const lineText = source.slice(lineStart, lineBreak === -1 ? source.length : lineBreak);
  const match = lineText.match(UNFINISHED_KEY_LINE);
  if (!match) return null;
  const [, indent, itemMarker, key] = match;
  const keyStart = lineStart + indent.length + itemMarker.length;
  if (keyStart !== err.pos[0]) return null;
  return { key, keyStart, range: rangeBetween(source, keyStart, keyStart + key.length) };
}

function documentWithoutUnfinishedKeys(source) {
  let parsedText = source;
  const unfinishedKeys = [];
  for (;;) {
    const doc = YAML.parseDocument(parsedText, { lineCounter: new YAML.LineCounter() });
    const found = doc.errors.map((err) => unfinishedKeyAt(parsedText, err)).filter(Boolean);
    if (found.length === 0) {
      unfinishedKeys.sort((left, right) => left.keyStart - right.keyStart);
      return { doc, unfinishedKeys: unfinishedKeys.map(({ key, range }) => ({ key, range })) };
    }
    for (const unfinishedKey of found) {
      unfinishedKeys.push(unfinishedKey);
      const keyEnd = unfinishedKey.keyStart + unfinishedKey.key.length;
      parsedText = parsedText.slice(0, unfinishedKey.keyStart)
        + ' '.repeat(unfinishedKey.key.length)
        + parsedText.slice(keyEnd);
    }
  }
}

function duplicateKeysOf(node, found = []) {
  if (!node) return found;
  if (node.kind === 'map') {
    const linesByKey = new Map();
    for (const entry of node.entries) {
      if (entry.key === null) continue;
      linesByKey.set(entry.key, [...(linesByKey.get(entry.key) || []), entry.keyRange.start.line]);
    }
    for (const entry of node.entries) {
      const lines = entry.key === null ? [] : linesByKey.get(entry.key);
      if (lines.length < 2) continue;
      const otherLines = lines.filter((line) => line !== entry.keyRange.start.line);
      found.push({ key: entry.key, keyStart: entry.keyStart, range: entry.keyRange, otherLines });
    }
    for (const entry of node.entries) duplicateKeysOf(entry.value, found);
  }
  if (node.kind === 'seq') for (const item of node.items) duplicateKeysOf(item, found);
  return found;
}

function parseYaml(text, nodeIds = createNodeIds(), tagKeys = []) {
  const source = String(text);
  const { doc, unfinishedKeys } = documentWithoutUnfinishedKeys(source);
  const context = { doc, nodeIds, nodeCount: 0, tagKeys };
  const tree = convert(doc.contents, source, new Set(), context);
  const duplicateKeys = duplicateKeysOf(tree);
  const duplicateKeyStarts = new Set(duplicateKeys.map((duplicate) => duplicate.keyStart));
  const errors = doc.errors
    .filter((err) => !(err.code === DUPLICATE_KEY_ERROR_CODE && duplicateKeyStarts.has(err.pos[0])))
    .map((err) => ({ message: err.message, range: errorRange(source, err) }));
  return {
    tree,
    errors,
    unfinishedKeys,
    duplicateKeys: duplicateKeys.map(({ key, range, otherLines }) => ({ key, range, otherLines })),
    value: plainValueOf(tree),
    nodeCount: context.nodeCount,
  };
}

function keyRangeAt(tree, path) {
  let node = tree;
  let range = null;
  for (const segment of path) {
    if (node && node.kind === 'map' && typeof segment === 'string') {
      const entry = node.entries.findLast((candidate) => candidate.key === segment);
      if (!entry) return null;
      range = entry.keyRange;
      node = entry.value;
    } else if (node && node.kind === 'seq' && typeof segment === 'number' && node.items[segment]) {
      node = node.items[segment];
      range = node.range;
    } else {
      return null;
    }
  }
  return range;
}

module.exports = { parseYaml, keyRangeAt };

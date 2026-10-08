const YAML = require('yaml');
const { rangeBetween } = require('./range');
const { createNodeIds } = require('./node-ids');

function errorRange(text, err) {
  const [errorStart, errorEnd] = err.pos;
  const start = Math.max(0, Math.min(errorStart, text.length));
  return rangeBetween(text, start, Math.max(start, Math.min(errorEnd, text.length)));
}

function valueIds(node, context) {
  return node ? { id: node.id, shapeId: node.shapeId } : context.nodeIds.scalarIds(null);
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
      return { kind: 'seq', ...span, ...ids, items };
    }
    if (YAML.isScalar(node)) {
      return { kind: 'scalar', ...span, ...context.nodeIds.scalarIds(node.value), value: node.value };
    }
    return null;
  } finally {
    seen.delete(node);
  }
}

function parseYaml(text, nodeIds = createNodeIds()) {
  const source = String(text);
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter });
  const context = { doc, nodeIds, nodeCount: 0 };
  return {
    tree: convert(doc.contents, source, new Set(), context),
    errors: doc.errors.map((err) => ({ message: err.message, range: errorRange(source, err) })),
    value: doc.contents ? doc.toJS({ maxAliasCount: 50 }) : null,
    nodeCount: context.nodeCount,
  };
}

module.exports = { parseYaml };

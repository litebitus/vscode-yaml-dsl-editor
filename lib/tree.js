const YAML = require('yaml');
const { rangeBetween } = require('./range');

function errorRange(text, err) {
  const pos = typeof err.pos === 'number' ? err.pos : 0;
  const start = Math.max(0, Math.min(pos, text.length));
  return rangeBetween(text, start, Math.min(text.length, start + 1));
}

function convert(node, text, seen, doc) {
  if (!node || typeof node !== 'object') return null;
  if (YAML.isAlias && YAML.isAlias(node)) {
    const resolved = typeof node.resolve === 'function' ? node.resolve(doc) : null;
    return convert(resolved, text, seen, doc);
  }
  if (seen.has(node)) return null;
  seen.add(node);
  try {
    const start = node.range ? node.range[0] : 0;
    const end = node.range ? node.range[1] : start;
    const span = { start, end, range: rangeBetween(text, start, end) };
    if (YAML.isMap(node)) {
      return {
        kind: 'map',
        ...span,
        entries: node.items.map((pair) => {
          const keyNode = pair.key;
          const rawKey = keyNode && Object.prototype.hasOwnProperty.call(keyNode, 'value') ? keyNode.value : null;
          const keyStart = keyNode && keyNode.range ? keyNode.range[0] : start;
          const keyEnd = keyNode && keyNode.range ? keyNode.range[1] : keyStart;
          return {
            key: typeof rawKey === 'string' || typeof rawKey === 'number' ? String(rawKey) : null,
            keyStart,
            keyEnd,
            keyRange: rangeBetween(text, keyStart, keyEnd),
            value: convert(pair.value, text, seen, doc),
          };
        }),
      };
    }
    if (YAML.isSeq(node)) {
      return {
        kind: 'seq',
        ...span,
        items: node.items.map((item) => convert(item, text, seen, doc)),
      };
    }
    if (YAML.isScalar(node)) {
      return { kind: 'scalar', ...span, value: node.value };
    }
    return null;
  } finally {
    seen.delete(node);
  }
}

function parseYaml(text) {
  const source = String(text);
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter });
  return {
    tree: convert(doc.contents, source, new Set(), doc),
    errors: doc.errors.map((err) => ({ message: err.message, range: errorRange(source, err) })),
    value: doc.contents ? doc.toJS({ maxAliasCount: 50 }) : null,
  };
}

module.exports = { parseYaml };

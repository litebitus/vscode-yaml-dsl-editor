const path = require('path');
const { parseYaml } = require('./tree');
const { collectSymbols, collectReferences } = require('./symbols');
const { fieldDescription } = require('./schema');
const { contains } = require('./range');

function analyzeDocument(text, filePath, dsl) {
  const parsed = parseYaml(text);
  const symbols = parsed.tree ? collectSymbols(parsed.tree, dsl.symbols, filePath, text) : [];
  const references = parsed.tree ? collectReferences(parsed.tree, dsl.references, filePath, text) : [];
  return {
    filePath,
    text,
    tree: parsed.tree,
    errors: parsed.errors,
    symbols,
    references,
    value: parsed.value,
  };
}

function locate(node, position, pathKeys = []) {
  if (!node || !contains(node.range, position)) return null;
  if (node.kind === 'map') {
    for (const entry of node.entries) {
      if (entry.keyRange && contains(entry.keyRange, position)) {
        return { path: [...pathKeys, entry.key], range: entry.keyRange, node: entry.value };
      }
      const nextPath = entry.key == null ? pathKeys : [...pathKeys, entry.key];
      const inner = locate(entry.value, position, nextPath);
      if (inner) return inner;
    }
    return { path: pathKeys, range: node.range, node };
  }
  if (node.kind === 'seq') {
    for (let index = 0; index < node.items.length; index += 1) {
      const inner = locate(node.items[index], position, [...pathKeys, index]);
      if (inner) return inner;
    }
    return { path: pathKeys, range: node.range, node };
  }
  return { path: pathKeys, range: node.range, node };
}

function referenceAt(references, position) {
  return references.find((ref) => contains(ref.range, position)) || null;
}

function sameTarget(symbol, ref) {
  if (symbol.kind !== ref.target.kind) return false;
  for (const [key, group] of Object.entries(ref.target)) {
    if (key === 'kind') continue;
    const wanted = ref.groups[group];
    if (key === 'name') {
      if (symbol.name !== wanted) return false;
    } else if (symbol.qualifiers[key] !== wanted) return false;
  }
  return true;
}

function snakeValue(text) {
  return String(text || '').trim().replaceAll('-', '_');
}

function pickSymbol(matches, activeFile, commonFile) {
  if (!matches || matches.length === 0) return null;
  const common = matches.find((symbol) => symbol.file === commonFile);
  if (common) return common;
  const active = matches.find((symbol) => symbol.file === activeFile);
  if (active) return active;
  let best = null;
  for (const symbol of matches) {
    if (!best || symbol.file < best.file) best = symbol;
  }
  return best;
}

function resolveSymbol(symbols, ref, activeFile, commonFile) {
  let matches = symbols.filter((symbol) => sameTarget(symbol, ref));
  if (matches.length === 0 && ref.target.kind === 'resource' && ref.groups.name) {
    const locals = symbols.filter((symbol) => (
      symbol.kind === 'local' && snakeValue(symbol.valueText) === ref.groups.name
    ));
    const local = locals.find((symbol) => symbol.file === activeFile)
      || locals.find((symbol) => symbol.file === commonFile)
      || locals[0];
    if (local) {
      const alias = `\${local.${local.name}}`;
      const type = ref.groups.type;
      matches = symbols.filter((symbol) => (
        symbol.kind === 'resource'
        && symbol.name === alias
        && (type == null || symbol.qualifiers.type === type)
      ));
    }
  }
  return pickSymbol(matches, activeFile, commonFile);
}

function plaintext(value, range) {
  return { contents: { kind: 'plaintext', value }, range };
}

function sectionText(text, startLine) {
  const lines = String(text || '').split('\n');
  if (startLine < 0 || startLine >= lines.length) return '';
  const first = lines[startLine];
  const indent = first.match(/^\s*/)[0].length;
  const out = [first];
  for (let i = startLine + 1; i < lines.length && out.length < 24; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push(line);
      continue;
    }
    if (line.match(/^\s*/)[0].length <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

function displayPath(file, root) {
  if (!file || !root) return file || '';
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
}

function withSection(value, ref, target, files, root) {
  if (!target || !files) return plaintext(value, ref.range);
  const doc = files.get(target.file);
  if (!doc || !target.keyRange) return plaintext(value, ref.range);
  const code = sectionText(doc.text, target.keyRange.start.line);
  if (!code) return plaintext(value, ref.range);
  const title = `${displayPath(target.file, root)}:${target.keyRange.start.line + 1}`;
  return {
    contents: {
      kind: 'markdown',
      value: `**${title}**\n\n\`\`\`yaml-dsl\n${code}\n\`\`\``,
    },
    range: ref.range,
  };
}

function referenceHover(ref, target, files, root) {
  if (ref.target.kind === 'local') {
    const value = target ? target.valueText : (ref.groups.name || '');
    return withSection(value, ref, target, files, root);
  }
  const type = ref.groups.type;
  const name = ref.groups.name || '';
  let value = type ? `${type}.${name}` : name;
  if (target) value = `${value} — ${displayPath(target.file, root)}`;
  return withSection(value, ref, target, files, root);
}

function hoverAt(doc, position, stack, schema) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (ref) {
    const target = resolveSymbol(stack.symbols, ref, doc.filePath, stack.common);
    return referenceHover(ref, target, stack.files, stack.root);
  }
  const located = locate(doc.tree, position);
  if (!located || !schema) return null;
  const description = fieldDescription(schema, located.path);
  if (!description) return null;
  return plaintext(description, located.range);
}

function definitionAt(doc, position, stack) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (!ref) return null;
  const target = resolveSymbol(stack.symbols, ref, doc.filePath, stack.common);
  if (!target) return null;
  return { path: target.file, range: target.keyRange, origin: ref.range };
}

function linksFor(doc, stack) {
  if (!doc) return [];
  const links = [];
  for (const ref of doc.references) {
    const target = resolveSymbol(stack.symbols, ref, doc.filePath, stack.common);
    if (!target) continue;
    links.push({ range: ref.range, path: target.file, targetRange: target.keyRange });
  }
  return links;
}

function linkTarget(filePath, range) {
  const end = range.end || range.start;
  return `${pathToUri(filePath)}#${range.start.line + 1},${range.start.character + 1},${end.line + 1},${end.character + 1}`;
}

function pathToUri(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

function uriToPath(uri) {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.slice('file://'.length));
}

module.exports = {
  analyzeDocument,
  hoverAt,
  definitionAt,
  linksFor,
  linkTarget,
  pathToUri,
  uriToPath,
};

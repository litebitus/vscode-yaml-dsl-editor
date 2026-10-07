const path = require('path');
const { parseYaml } = require('./tree');
const { collectSymbols, collectReferences } = require('./symbols');
const { fieldDescription } = require('./schema');
const { contains } = require('./range');
const { resolveSymbol, targetScopeOf, localValuesOf } = require('./scope-resolution');
const { localsScopeName } = require('./local-values');
const { semanticTokensFor, TOKEN_TYPES, TOKEN_MODIFIERS } = require('./semantic-tokens');
const { completionsAt, sectionText, displayPath } = require('./completion-offers');
const { matchWholeReference } = require('./placeholder-scan');
const { collectCalls, callProblems, parseFunctionKey, signatureText } = require('./function-calls');
const { WHOLE_SCALAR } = require('./reference-positions');

function markerFunctionOf(dsl) {
  return dsl.function ? dsl.function.markerFunction : null;
}

function analyzeDocument(text, filePath, dsl, nodeIds) {
  const parsed = parseYaml(text, nodeIds);
  const symbols = parsed.tree ? collectSymbols(parsed.tree, dsl, filePath, text) : [];
  const found = parsed.tree
    ? collectReferences(parsed.tree, dsl, filePath, text)
    : { references: [], placeholders: [], problems: [] };
  return {
    filePath,
    text,
    tree: parsed.tree,
    errors: parsed.errors,
    symbols,
    references: found.references,
    placeholders: found.placeholders,
    referenceProblems: found.problems,
    calls: parsed.tree ? collectCalls(parsed.tree, markerFunctionOf(dsl), text) : [],
    value: parsed.value,
    nodeCount: parsed.nodeCount,
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

function plaintext(value, range) {
  return { contents: { kind: 'plaintext', value }, range };
}

function withSection(value, ref, target, files, root) {
  if (!target || target.builtin || !files) return plaintext(value, ref.range);
  const doc = files.get(target.file);
  if (!doc || !target.keyRange) return plaintext(value, ref.range);
  const code = sectionText(doc.text, target.keyRange.start.line);
  if (!code) return plaintext(value, ref.range);
  const line = target.keyRange.start.line + 1;
  const title = `${displayPath(target.file, root)}:${line}`;
  return {
    contents: {
      kind: 'markdown',
      value: `[${title}](${pathToUri(target.file)}#L${line})\n\n\`\`\`yaml-dsl\n${code}\n\`\`\``,
    },
    range: ref.range,
  };
}

function localValueText(target, stack, activeFile) {
  if (!target || target.builtin || target.scopeName !== localsScopeName(stack.dsl)) return null;
  const local = localValuesOf(stack, activeFile).valueOf(target.name);
  return local && local.symbol === target && local.known ? local.text : null;
}

function referenceHover(ref, target, stack, activeFile) {
  const { files, root } = stack;
  const name = ref.groups[ref.rule.nameGroup] || '';
  const scope = targetScopeOf(ref) || '';
  if (target && target.builtin) return plaintext(`${scope} ${name}`, ref.range);
  const localText = localValueText(target, stack, activeFile);
  if (localText !== null) return withSection(localText, ref, target, files, root);
  if (target && target.valueIsScalar) return withSection(target.valueText, ref, target, files, root);
  let value = `${scope}.${name}`;
  if (target) value = `${value} — ${displayPath(target.file, root)}`;
  return withSection(value, ref, target, files, root);
}

function functionHover(doc, position, stack) {
  const call = (doc.calls || []).find((item) => contains(item.functionRange, position));
  if (!call) return null;
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  const parameters = table ? table[call.functionName] : null;
  const text = parameters ? signatureText(call.functionName, parameters) : `${call.functionName}`;
  return plaintext(text, call.functionRange);
}

function hoverAt(doc, position, stack, schema) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (ref) return referenceHover(ref, resolveSymbol(stack, ref, doc.filePath), stack, doc.filePath);
  const called = functionHover(doc, position, stack);
  if (called) return called;
  const located = locate(doc.tree, position);
  if (!located || !schema) return null;
  const description = fieldDescription(schema, located.path);
  if (!description) return null;
  return plaintext(description, located.range);
}

function declaredTarget(stack, ref, activeFile) {
  const target = resolveSymbol(stack, ref, activeFile);
  return target && !target.builtin ? target : null;
}

function definitionAt(doc, position, stack) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (!ref) return null;
  const target = declaredTarget(stack, ref, doc.filePath);
  if (!target) return null;
  return { path: target.file, range: target.keyRange, origin: ref.range };
}

function linksFor(doc, stack) {
  if (!doc) return [];
  const links = [];
  for (const ref of doc.references) {
    const target = declaredTarget(stack, ref, doc.filePath);
    if (target) links.push({ range: ref.range, path: target.file, targetRange: target.keyRange });
  }
  return links;
}

function classifiedReferences(doc, stack) {
  if (!doc) return [];
  return doc.references.map((ref) => {
    const target = resolveSymbol(stack, ref, doc.filePath);
    if (!target) return { range: ref.range, kind: 'error' };
    if (target.builtin) return { range: ref.range, kind: 'builtin' };
    return { range: ref.range, kind: target.file === doc.filePath ? 'local' : 'external' };
  });
}

function expressionCheck(dsl) {
  const wholeRules = (dsl.references || []).filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  const placeholderPattern = dsl.placeholder ? new RegExp(dsl.placeholder.pattern) : null;
  return (text, isKey) => {
    if (isKey) {
      const parsed = parseFunctionKey(text, markerFunctionOf(dsl));
      return Boolean(parsed) && parsed.name === null;
    }
    if (matchWholeReference(text, wholeRules)) return true;
    return Boolean(placeholderPattern) && placeholderPattern.test(text);
  };
}

function callResultProblems(doc, stack) {
  const functionConfig = stack.dsl.function;
  if (!functionConfig) return [];
  const problems = [];
  for (const ref of doc.references) {
    const target = resolveSymbol(stack, ref, doc.filePath);
    if (!target || !target.call || functionConfig.callResultReferencePositions.includes(ref.position)) continue;
    problems.push({
      range: ref.range,
      message: `a call result is not allowed as ${ref.position}`,
    });
  }
  return problems;
}

function analysisProblems(doc, stack) {
  if (!doc) return [];
  const problems = [...(doc.referenceProblems || [])];
  const functionConfig = stack.dsl.function;
  if (functionConfig) {
    const vocabulary = stack.vocabulary || { table: {}, complete: false };
    problems.push(...callProblems(doc.calls || [], functionConfig, vocabulary, expressionCheck(stack.dsl)));
  }
  problems.push(...callResultProblems(doc, stack));
  problems.push(...localCycleProblems(doc, stack));
  return problems;
}

function localCycleProblems(doc, stack) {
  if (!localsScopeName(stack.dsl)) return [];
  const localValues = localValuesOf(stack, doc.filePath);
  return localValues.declarations()
    .filter((symbol) => symbol.file === doc.filePath && localValues.isCyclic(symbol.name))
    .map((symbol) => ({
      range: symbol.keyRange,
      message: `local ${symbol.name} reaches itself through its references`,
    }));
}

function tokensFor(doc, stack) {
  return semanticTokensFor(doc, (ref) => {
    const target = resolveSymbol(stack, ref, doc.filePath);
    return Boolean(target && target.builtin);
  });
}

function completionAt(doc, lineText, position, stack) {
  const located = doc && doc.tree ? locate(doc.tree, position) : null;
  const site = { file: doc ? doc.filePath : null, documentPath: located ? located.path : [] };
  return completionsAt(lineText, position, site, stack, site.file);
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
  classifiedReferences,
  analysisProblems,
  completionAt,
  tokensFor,
  TOKEN_TYPES,
  TOKEN_MODIFIERS,
  linkTarget,
  pathToUri,
  uriToPath,
};

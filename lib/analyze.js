const path = require('path');
const { parseYaml, treeAtMergePoint, valueAtMergePoint } = require('./tree');
const { createNodeIds } = require('./node-ids');
const { overlayIncludesOf } = require('./overlay-includes');
const { collectSymbols, collectReferences } = require('./symbols');
const { schemaParserForDocument } = require('./json-schema');
const { contains, rangeBetween } = require('./range');
const {
  resolveSymbol,
  resolveTargets,
  targetScopeOf,
  localValuesOf,
} = require('./scope-resolution');
const { localsScopeName, localPathStepsOf } = require('./local-values');
const { semanticTokensFor, TOKEN_TYPES, TOKEN_MODIFIERS } = require('./semantic-tokens');
const {
  completionsAt,
  sectionText,
  displayPath,
  builtinDocumentationOf,
} = require('./completion-offers');
const { matchWholeReference } = require('./placeholder-scan');
const { callKeySiteAt } = require('./schema-completion');
const {
  collectCalls,
  callProblems,
  parseFunctionKey,
  functionDocumentationOf,
  argumentDocumentationOf,
  bindsArgumentsByName,
  calledEntryOf,
  isFunctionCallMacro,
  calleeNamesOf,
  calleeWrittenAt,
  unmarkedCallsOf,
  standsAsBareKey,
  macroRoleParameterOf,
} = require('./function-calls');
const { WHOLE_SCALAR } = require('./reference-positions');
const { tagOfKey } = require('./tag-keys');
const { fieldDocumentationOf } = require('./field-documentation');
const { codeSpan } = require('./json-schema/render');
const { loopVariableDocumentationOf } = require('./loops');
const { fieldSetByKey } = require('./validation-document');
const { hoverHeading, markdownWithoutHtml, termsWrappingBetween } = require('./hover-heading');
const { mergeTargetTermsOf } = require('./merge-target-terms');
const { DARK_THEME, THEME_ROLES, themeColorVariable } = require('./themes');

const DEPRECATED_LABEL = 'deprecated';
const NOT_A_FIELD_TEXT = 'not a field';

function markerFunctionOf(dsl) {
  return dsl.function ? dsl.function.markerFunction : null;
}

function analyzeDocument(text, filePath, dsl, nodeIds = createNodeIds(), mergePoint = []) {
  const parsed = parseYaml(text, nodeIds, dsl.tagKeys);
  const merged = mergePoint.length > 0 && parsed.tree !== null;
  const tree = merged ? treeAtMergePoint(parsed.tree, mergePoint, nodeIds, text) : parsed.tree;
  const symbols = tree ? collectSymbols(tree, dsl, filePath, text) : [];
  const found = tree
    ? collectReferences(tree, dsl, filePath, text)
    : { references: [], placeholders: [], problems: [] };
  const includes = overlayIncludesOf(parsed.tree, dsl.layers, filePath, dsl.dir);
  const calls = tree ? collectCalls(tree, markerFunctionOf(dsl), text) : [];
  return {
    filePath,
    text,
    tree,
    mergePoint: merged ? mergePoint : [],
    includes,
    errors: parsed.errors,
    unfinishedKeys: parsed.unfinishedKeys,
    duplicateKeys: parsed.duplicateKeys,
    symbols,
    references: found.references,
    placeholders: found.placeholders,
    referenceProblems: found.problems,
    calls,
    value: merged ? valueAtMergePoint(parsed.value, mergePoint) : parsed.value,
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

function startsAfter(range, other) {
  return range.start.line > other.start.line
    || (range.start.line === other.start.line && range.start.character > other.start.character);
}

function referenceAt(references, position) {
  return references
    .filter((ref) => contains(ref.range, position))
    .reduce((innermost, ref) => (innermost && !startsAfter(ref.range, innermost.range) ? innermost : ref), null);
}

const MARKDOWN_SYNTAX = /[\\`*_{}[\]()#+\-.!|<>~]/g;

function plaintext(value, range) {
  const markdown = String(value).replace(MARKDOWN_SYNTAX, '\\$&').replace(/\n/g, '  \n');
  return { contents: { kind: 'markdown', value: markdown }, range };
}

function sectionMarkdown(target, files, title) {
  const doc = files.get(target.file);
  if (!doc || !target.keyRange) return null;
  const code = sectionText(doc.text, target.keyRange.start.line);
  if (!code) return null;
  const line = target.keyRange.start.line + 1;
  return `[${title}](${pathToUri(target.file)}#L${line})\n\n\`\`\`yaml-dsl\n${code}\n\`\`\``;
}

function withSection(value, ref, target, files, root) {
  if (!target || target.builtin || !files || !target.keyRange) return plaintext(value, ref.range);
  const title = `${displayPath(target.file, root)}:${target.keyRange.start.line + 1}`;
  const section = sectionMarkdown(target, files, title);
  if (!section) return plaintext(value, ref.range);
  return { contents: { kind: 'markdown', value: section }, range: ref.range };
}

function layerSectionsHover(ref, targets, stack) {
  if (!stack.files || !stack.layerLabelOf) return null;
  const sections = targets
    .map((target) => sectionMarkdown(target, stack.files, stack.layerLabelOf(target.file)))
    .filter(Boolean);
  if (sections.length === 0) return null;
  return { contents: { kind: 'markdown', value: sections.join('\n\n') }, range: ref.range };
}

function localValueText(target, stack, activeFile) {
  if (!target || target.builtin || target.scopeName !== localsScopeName(stack.dsl)) return null;
  const local = localValuesOf(stack, activeFile).valueOf(target.name);
  return local && local.symbol === target && local.known ? local.text : null;
}

function loopVariableHover(target, range) {
  return { contents: { kind: 'markdown', value: loopVariableDocumentationOf(target.loop, target.name) }, range };
}

function localContentOfReference(ref, stack) {
  const readsLocal = Boolean(stack.dsl) && ref.rule.scopeName === localsScopeName(stack.dsl);
  const steps = readsLocal ? localPathStepsOf(ref.trailingText, stack.dsl) : [];
  if (steps.length === 0 || !stack.localContentAt) return null;
  return stack.localContentAt(ref.groups[ref.rule.nameGroup], steps);
}

function missingStepMessage(ref, missing, doc, dsl) {
  const held = [doc.text.slice(ref.span.start, ref.span.end), ...missing.heldSteps].join(dsl.locals.pathSeparator);
  return `${codeSpan(held)} holds no ${codeSpan(missing.step)}`;
}

function referenceHover(ref, targets, stack, doc) {
  if (targets.length > 1) {
    const sections = layerSectionsHover(ref, targets, stack);
    if (sections) return sections;
  }
  const target = targets[0] || null;
  const { files, root } = stack;
  const name = ref.groups[ref.rule.nameGroup] || '';
  const scope = targetScopeOf(ref) || '';
  if (!target) return plaintext(`Invalid reference: ${scope}.${name}`, ref.range);
  if (target.builtin) return { contents: { kind: 'markdown', value: builtinDocumentationOf(target.name) }, range: ref.range };
  if (target.loopVariable) return loopVariableHover(target, ref.range);
  const content = localContentOfReference(ref, stack);
  if (content && content.missing) {
    const value = missingStepMessage(ref, content.missing, doc, stack.dsl);
    return { contents: { kind: 'markdown', value }, range: ref.range };
  }
  if (content) {
    return withSection(target.valueText, ref, { file: content.filePath, keyRange: content.keyRange }, files, root);
  }
  const localText = localValueText(target, stack, doc.filePath);
  if (localText !== null) return withSection(localText, ref, target, files, root);
  if (target.valueIsScalar) return withSection(target.valueText, ref, target, files, root);
  return withSection(`${scope}.${name} — ${displayPath(target.file, root)}`, ref, target, files, root);
}

function callsOf(doc, table) {
  return [...(doc.calls || []), ...unmarkedCallsOf(doc.tree, table)];
}

function documentedCall(called, range) {
  return { contents: { kind: 'markdown', value: functionDocumentationOf(called.calledName, called.entry) }, range };
}

function functionHover(doc, position, stack) {
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  const calls = callsOf(doc, table);
  const call = calls.find((item) => contains(item.functionRange, position));
  if (call) {
    const called = calledEntryOf(table, call.functionName, standsAsBareKey(call));
    return called ? documentedCall(called, call.functionRange) : plaintext(call.functionName, call.functionRange);
  }
  for (const candidate of calls) {
    const called = calledEntryOf(table, candidate.functionName, standsAsBareKey(candidate));
    if (!isFunctionCallMacro(called)) continue;
    const callee = calleeNamesOf(candidate, called.entry).find((named) => contains(named.range, position));
    const calleeIsMacro = macroRoleParameterOf(called.entry, 'callee').type === 'macro';
    const calledCallee = callee ? calledEntryOf(table, callee.name, calleeIsMacro) : null;
    if (calledCallee) return documentedCall(calledCallee, callee.range);
  }
  return null;
}

function argumentHover(doc, position, stack) {
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  for (const call of callsOf(doc, table)) {
    if (!call.value || call.value.kind !== 'map') continue;
    const called = calledEntryOf(table, call.functionName, standsAsBareKey(call));
    if (!called || !called.entry.macro || !bindsArgumentsByName(call.value, called.entry.arguments)) continue;
    const item = call.value.entries.find((entry) => entry.keyRange && contains(entry.keyRange, position));
    const parameter = item ? called.entry.arguments.find((candidate) => candidate.name === item.key) : null;
    if (!parameter) continue;
    const value = argumentDocumentationOf(parameter);
    return { contents: { kind: 'markdown', value }, range: item.keyRange };
  }
  return null;
}

function documentationWithSetField(parser, fieldPath, setField) {
  const documentation = fieldDocumentationOf(parser, fieldPath);
  const setFieldDocumentation = documentation && setField
    ? fieldDocumentationOf(parser, [...fieldPath, setField.field])
    : null;
  if (!setFieldDocumentation) return documentation;
  const setsLine = `*Sets* ${codeSpan(setField.field)} *to* ${codeSpan(setField.value)}:`;
  return `${documentation}\n\n${setsLine}\n\n${setFieldDocumentation}`;
}

function fieldSetAt(located, dsl) {
  const key = located.path[located.path.length - 1];
  if (typeof key !== 'string' || !dsl || !located.node || located.node.kind !== 'map') return null;
  const setField = fieldSetByKey(key, dsl);
  const writesField = setField && located.node.entries.some((entry) => entry.key === setField.field);
  return writesField ? null : setField;
}

function suppliedFieldPathOf(path, dsl) {
  const call = dsl ? parseFunctionKey(path[path.length - 1], markerFunctionOf(dsl)) : null;
  return call && call.name !== null ? [...path.slice(0, -1), call.name] : path;
}

function documentationSectionsOf(labeledSchemas, fieldPath, setField) {
  const sections = [];
  const notFieldTerms = [];
  for (const labeledSchema of labeledSchemas) {
    const { label, targetPath = null, schema, documentValue, schemaPathOf, fragmentPointer = null } = labeledSchema;
    const term = { label, targetPath };
    const parser = schemaParserForDocument(schema, documentValue, fragmentPointer);
    const schemaPath = schemaPathOf ? schemaPathOf(fieldPath) : fieldPath;
    if (parser && label !== null && parser.nodeAt(schemaPath) === null) notFieldTerms.push(term);
    const documentation = parser ? documentationWithSetField(parser, schemaPath, setField) : null;
    if (!documentation) continue;
    const same = sections.find((section) => section.documentation === documentation);
    if (same) same.terms.push(term);
    else sections.push({ terms: [term], documentation });
  }
  return { sections, notFieldTerms };
}

function sectionHeadingTextOf(terms) {
  if (terms.every((term) => term.targetPath === null)) return terms.map((term) => term.label).join(', ');
  return termsWrappingBetween(mergeTargetTermsOf(terms.map((term) => ({ label: term.label, path: term.targetPath }))));
}

function hoverAt(
  doc,
  position,
  stack,
  schema,
  labeledSchemas = [],
  theme = DARK_THEME,
  mergedLocalSchemasAt = () => null,
) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (ref) return referenceHover(ref, resolveTargets(stack, ref, doc.filePath), stack, doc);
  const called = functionHover(doc, position, stack) || argumentHover(doc, position, stack);
  if (called) return called;
  const located = locate(doc.tree, position);
  if (!located || located.path.length === 0) return null;
  const mergedLocalSchemas = mergedLocalSchemasAt(located.path.slice(0, -1));
  const readSchemas = mergedLocalSchemas || (labeledSchemas.length > 0 ? labeledSchemas : [{ label: null, schema }]);
  const setField = fieldSetAt(located, stack && stack.dsl);
  const fieldPath = suppliedFieldPathOf(located.path, stack && stack.dsl);
  const { sections, notFieldTerms } = documentationSectionsOf(readSchemas, fieldPath, setField);
  if (sections.length === 0) return null;
  const headingColor = themeColorVariable(theme, THEME_ROLES.overlayHeading);
  const termedSectionText = (terms, body) => `${hoverHeading(sectionHeadingTextOf(terms), headingColor)}\n\n${body}`;
  const sectionTexts = sections.length === 1 && notFieldTerms.length === 0
    ? [markdownWithoutHtml(sections[0].documentation)]
    : sections.map(({ terms, documentation }) => termedSectionText(terms, markdownWithoutHtml(documentation)));
  if (notFieldTerms.length > 0) sectionTexts.push(termedSectionText(notFieldTerms, NOT_A_FIELD_TEXT));
  return { contents: { kind: 'markdown', value: sectionTexts.join('\n\n') }, range: located.range };
}

function deprecatedFieldMessage(key, description) {
  const named = `\`${String(key).replaceAll('`', "'")}\` is ${DEPRECATED_LABEL}`;
  return description ? `${named}: ${description}` : named;
}

function deprecatedFields(doc, schema, fragmentPointer = null) {
  const parser = doc && doc.tree ? schemaParserForDocument(schema, undefined, fragmentPointer) : null;
  if (!parser || !parser.draft.readsDeprecated) return [];
  const fields = [];
  const visit = (node, path) => {
    if (node && node.kind === 'map') {
      for (const entry of node.entries) {
        if (entry.key === null) continue;
        const entryPath = [...path, entry.key];
        if (parser.fieldDeprecated(entryPath)) {
          const message = deprecatedFieldMessage(entry.key, parser.fieldDescription(entryPath));
          const fieldEnd = entry.value ? entry.value.end : entry.keyEnd;
          fields.push({ range: entry.keyRange, fieldRange: rangeBetween(doc.text, entry.keyStart, fieldEnd), message });
        }
        visit(entry.value, entryPath);
      }
    }
    if (node && node.kind === 'seq') node.items.forEach((item, index) => visit(item, [...path, index]));
  };
  visit(doc.tree, []);
  return fields;
}

function declaredTargets(stack, ref, activeFile) {
  return resolveTargets(stack, ref, activeFile).filter((target) => !target.builtin);
}

function definitionAt(doc, position, stack) {
  if (!doc) return null;
  const ref = referenceAt(doc.references, position);
  if (!ref) return null;
  const targets = declaredTargets(stack, ref, doc.filePath);
  if (targets.length !== 1) return null;
  const content = localContentOfReference(ref, stack);
  if (content && content.missing) return null;
  if (content) return { path: content.filePath, range: content.keyRange, origin: ref.range };
  return { path: targets[0].file, range: targets[0].keyRange, origin: ref.range };
}

function linksFor(doc, stack) {
  if (!doc) return [];
  const links = [];
  for (const ref of doc.references) {
    const targets = declaredTargets(stack, ref, doc.filePath);
    if (targets.length < 2) continue;
    links.push({
      range: ref.range,
      targets: targets.map((target) => ({ path: target.file, targetRange: target.keyRange })),
    });
  }
  return links;
}

function classifiedReferences(doc, stack) {
  if (!doc) return [];
  return doc.references.map((ref) => {
    const target = resolveSymbol(stack, ref, doc.filePath);
    if (!target) return { range: ref.range, kind: 'error' };
    if (target.builtin) return { range: ref.range, kind: 'builtin' };
    const content = localContentOfReference(ref, stack);
    if (content && content.missing) return { range: ref.range, kind: 'error' };
    return { range: ref.range, kind: target.file === doc.filePath ? 'local' : 'external' };
  });
}

function expressionCheck(dsl) {
  const wholeRules = (dsl.references || []).filter((rule) => rule.positions.includes(WHOLE_SCALAR));
  const placeholderPattern = dsl.placeholder ? new RegExp(dsl.placeholder.pattern) : null;
  return (text, isKey, keyedValue = null) => {
    if (isKey) {
      const parsed = parseFunctionKey(text, markerFunctionOf(dsl));
      if (parsed) return parsed.name === null;
      const tag = tagOfKey(dsl.tagKeys, text);
      const keyedText = keyedValue && keyedValue.kind === 'scalar' ? String(keyedValue.value) : null;
      return Boolean(tag) && keyedText !== null && Boolean(matchWholeReference(`${tag} ${keyedText}`, wholeRules));
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

function functionCallProblemsOf(doc, stack) {
  const functionConfig = stack.dsl.function;
  if (!functionConfig) return [];
  const readings = stack.vocabularies
    || [{ label: null, vocabulary: stack.vocabulary || { table: {}, complete: false } }];
  const problemsSeen = new Map();
  for (const { label, vocabulary } of readings) {
    const calls = callsOf(doc, vocabulary.table);
    for (const problem of callProblems(calls, functionConfig, vocabulary, expressionCheck(stack.dsl))) {
      const problemKey = JSON.stringify([problem.range, problem.message]);
      if (!problemsSeen.has(problemKey)) problemsSeen.set(problemKey, { problem, labels: [] });
      if (label !== null) problemsSeen.get(problemKey).labels.push(label);
    }
  }
  return [...problemsSeen.values()].map(({ problem, labels }) => (
    labels.length > 0 ? { ...problem, message: `${problem.message} (${labels.join(', ')})` } : problem
  ));
}

function analysisProblems(doc, stack) {
  if (!doc) return [];
  const problems = [...(doc.referenceProblems || [])];
  problems.push(...functionCallProblemsOf(doc, stack));
  problems.push(...callResultProblems(doc, stack));
  problems.push(...localCycleProblems(doc, stack));
  problems.push(...localPathProblems(doc, stack));
  return problems;
}

function localPathProblems(doc, stack) {
  const problems = [];
  for (const ref of doc.references) {
    if (!resolveSymbol(stack, ref, doc.filePath)) continue;
    const content = localContentOfReference(ref, stack);
    if (content && content.missing) {
      problems.push({ range: ref.range, message: missingStepMessage(ref, content.missing, doc, stack.dsl) });
    }
  }
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
  const table = stack.vocabulary ? stack.vocabulary.table : null;
  const calleeCall = doc && doc.tree
    ? callsOf(doc, table)
      .map((call) => ({ call, called: calledEntryOf(table, call.functionName, standsAsBareKey(call)) }))
      .find(({ call, called }) => isFunctionCallMacro(called) && calleeWrittenAt(call, called.entry, position))
    : null;
  const calleeType = calleeCall ? macroRoleParameterOf(calleeCall.called.entry, 'callee').type : null;
  const markerFunction = stack.dsl.function ? stack.dsl.function.markerFunction : null;
  const callSite = doc && markerFunction
    ? callKeySiteAt(doc.text, position, markerFunction.callMarker, stack.dsl.tagKeys, doc.mergePoint || [])
    : null;
  const site = { file: doc ? doc.filePath : null, documentPath: located ? located.path : [], calleeType, callSite };
  return completionsAt(lineText, position, site, stack, site.file);
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
  deprecatedFields,
  definitionAt,
  linksFor,
  classifiedReferences,
  analysisProblems,
  completionAt,
  tokensFor,
  TOKEN_TYPES,
  TOKEN_MODIFIERS,
  pathToUri,
  uriToPath,
};

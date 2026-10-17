const { rangeBetween, contains } = require('./range');
const { pathMatches, parseAt } = require('./document-path');

const ARGUMENT_TYPES = ['text', 'number', 'whole_number', 'boolean', 'list', 'map', 'function', 'macro', 'any'];
const ENTRY_NAME_TYPES = ['function', 'macro'];
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_:-]*$/;
const VOID_RETURN_TYPE = 'void';
const SIGNATURE_LANGUAGE = 'yaml-dsl-signature';
const MACRO_ROLES = {
  function_call: [
    { role: 'callee', field: 'callee', types: ['text', ...ENTRY_NAME_TYPES], required: true },
    { role: 'calleeArguments', field: 'callee_arguments', types: ['map'], required: false },
  ],
  merge: [
    { role: 'content', field: 'content', types: ['text', 'map'], required: true, repeatable: true },
  ],
  loop: [
    { role: 'loopVariable', field: 'loop_variable', types: ['text'], required: true },
    { role: 'collection', field: 'collection', types: ['list'], required: true },
    { role: 'body', field: 'body', types: ['map'], required: true },
  ],
  transform: [],
};
const MACRO_KINDS = Object.keys(MACRO_ROLES);
const MERGE_BEHAVIORS = ['shallow', 'deep', 'join'];
const MERGE_VERBS = { shallow: 'merged over', deep: 'merged key by key over', join: 'joined with' };
const suffixExpressionsByPattern = new Map();

function parseFunctionKey(key, markerFunction) {
  if (!markerFunction || typeof key !== 'string') return null;
  const { callMarker, splatOperator } = markerFunction;
  const lastSpace = key.trimEnd().lastIndexOf(' ');
  const callStart = lastSpace + 1;
  const callText = key.slice(callStart).trimEnd();
  if (!callText.startsWith(callMarker)) return null;
  const splat = splatOperator !== null && callText.endsWith(splatOperator);
  const functionName = callText.slice(callMarker.length, splat ? -splatOperator.length : undefined);
  if (!FUNCTION_NAME.test(functionName)) return null;
  return {
    name: lastSpace < 0 ? null : key.slice(0, lastSpace).trim(),
    functionName,
    splat,
    markerStart: callStart,
    nameStart: callStart + callMarker.length,
    nameEnd: callStart + callMarker.length + functionName.length,
    callEnd: callStart + callText.length,
  };
}

function collectCalls(tree, markerFunction, text) {
  const calls = [];
  if (!markerFunction) return calls;
  function visit(node, documentPath) {
    if (!node) return;
    if (node.kind === 'map') {
      for (const entry of node.entries) {
        const entryPath = [...documentPath, entry.key];
        const parsed = entry.key == null ? null : parseFunctionKey(entry.key, markerFunction);
        if (parsed) {
          const writtenAsKey = text.slice(entry.keyStart, entry.keyEnd) === entry.key;
          const absolute = (offset) => (writtenAsKey ? entry.keyStart + offset : entry.keyStart);
          const functionEnd = writtenAsKey ? absolute(parsed.nameEnd) : entry.keyEnd;
          calls.push({
            ...parsed,
            documentPath: entryPath,
            keyRange: entry.keyRange,
            markerRange: rangeBetween(text, absolute(parsed.markerStart), absolute(parsed.nameStart)),
            functionRange: rangeBetween(text, absolute(parsed.nameStart), functionEnd),
            splatRange: rangeBetween(text, functionEnd, writtenAsKey ? absolute(parsed.callEnd) : functionEnd),
            value: entry.value,
            siblingCount: node.entries.length,
          });
        }
        visit(entry.value, entryPath);
      }
      return;
    }
    if (node.kind === 'seq') node.items.forEach((item, index) => visit(item, [...documentPath, index]));
  }
  visit(tree, []);
  return calls;
}

function unmarkedCallsOf(tree, table) {
  const macros = Object.entries(table || {})
    .filter(([, entry]) => entry.macro && entry.macro.unmarkedKeyPaths.length > 0);
  const calls = [];
  if (macros.length === 0) return calls;
  const macroNameAt = (documentPath) => {
    const found = macros.find(([, entry]) => entry.macro.unmarkedKeyPaths
      .some((tokens) => pathMatches(tokens, documentPath)));
    return found ? found[0] : null;
  };
  function visit(node, documentPath) {
    if (!node) return;
    if (node.kind === 'seq') {
      node.items.forEach((item, index) => visit(item, [...documentPath, index]));
      return;
    }
    if (node.kind !== 'map') return;
    for (const entry of node.entries) {
      if (entry.key == null) continue;
      const entryPath = [...documentPath, entry.key];
      const macroName = macroNameAt(entryPath);
      if (macroName) {
        calls.push({
          name: null,
          functionName: macroName,
          splat: false,
          documentPath: entryPath,
          keyRange: entry.keyRange,
          functionRange: entry.keyRange,
          value: entry.value,
          siblingCount: node.entries.length,
        });
      }
      visit(entry.value, entryPath);
    }
  }
  visit(tree, []);
  return calls;
}

function terraformType(type) {
  const head = Array.isArray(type) ? type[0] : type;
  const mapped = {
    string: 'text',
    number: 'number',
    bool: 'boolean',
    list: 'list',
    set: 'list',
    tuple: 'list',
    map: 'map',
    object: 'map',
  };
  return mapped[head] || 'any';
}

function terraformVocabulary(metadata) {
  const signatures = metadata && metadata.function_signatures;
  if (!signatures || typeof signatures !== 'object') return null;
  const vocabulary = {};
  for (const [functionName, signature] of Object.entries(signatures)) {
    const parameters = (signature.parameters || []).map((parameter) => ({
      name: parameter.name,
      type: terraformType(parameter.type),
      required: true,
      repeated: false,
      description: parameter.description || null,
    }));
    if (signature.variadic_parameter) {
      parameters.push({
        name: signature.variadic_parameter.name,
        type: terraformType(signature.variadic_parameter.type),
        required: false,
        repeated: true,
        description: signature.variadic_parameter.description || null,
      });
    }
    vocabulary[functionName] = {
      description: signature.description || null,
      arguments: parameters,
      return: signature.return_type ? { type: terraformType(signature.return_type), description: null } : null,
      macro: null,
    };
  }
  return vocabulary;
}

function pointerTarget(document, pointer) {
  let node = document;
  for (const part of pointer.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node;
}

function isNonEmptyText(value) {
  return typeof value === 'string' && value !== '';
}

function argumentsProblem(label, parameters, descriptionsRequired) {
  let optionalSeen = false;
  for (const [index, parameter] of parameters.entries()) {
    const argumentLabel = `${label}[${index}]`;
    if (!parameter || !isNonEmptyText(parameter.name)) return `${argumentLabel}.name is required`;
    if (!ARGUMENT_TYPES.includes(parameter.type)) {
      return `${argumentLabel}.type must be one of ${ARGUMENT_TYPES.join(', ')}`;
    }
    if (typeof parameter.required !== 'boolean') return `${argumentLabel}.required must be true or false`;
    if (typeof parameter.repeated !== 'boolean') return `${argumentLabel}.repeated must be true or false`;
    if (descriptionsRequired && !isNonEmptyText(parameter.description)) return `${argumentLabel}.description is required`;
    if (parameter.repeated && index !== parameters.length - 1) {
      return `${argumentLabel} repeats but is not the last argument`;
    }
    if (parameter.required && optionalSeen) return `${argumentLabel} is required after an optional argument`;
    if (!parameter.required) optionalSeen = true;
  }
  return null;
}

function tableEntryProblem(functionName, entry) {
  if (Array.isArray(entry)) return argumentsProblem(functionName, entry, false);
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.arguments)) {
    return `${functionName} must be a mapping with description and arguments`;
  }
  if (!isNonEmptyText(entry.description)) return `${functionName}.description is required`;
  return argumentsProblem(`${functionName}.arguments`, entry.arguments, true)
    || returnProblem(functionName, entry.return)
    || macroProblem(functionName, entry);
}

function compilesAsExpression(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function macroProblem(functionName, entry) {
  const { macro } = entry;
  if (macro === undefined) return null;
  if (!macro || typeof macro !== 'object' || Array.isArray(macro)) {
    return `${functionName}.macro must be a mapping with kind`;
  }
  if (!MACRO_KINDS.includes(macro.kind)) return `${functionName}.macro.kind must be one of ${MACRO_KINDS.join(', ')}`;
  if (macro.kind === 'merge' && !MERGE_BEHAVIORS.includes(macro.merge_behavior)) {
    return `${functionName}.macro.merge_behavior must be one of ${MERGE_BEHAVIORS.join(', ')}`;
  }
  if (macro.kind !== 'merge' && macro.merge_behavior !== undefined) {
    return `${functionName}.macro.merge_behavior is read only on a merge macro`;
  }
  const suffixPattern = macro.name_suffix_pattern;
  if (suffixPattern !== undefined && !(isNonEmptyText(suffixPattern) && compilesAsExpression(suffixPattern))) {
    return `${functionName}.macro.name_suffix_pattern must be a regular expression`;
  }
  const keyPaths = macro.unmarked_key_paths;
  const isKeyPath = (keyPath) => {
    const tokens = parseAt(keyPath);
    return Boolean(tokens) && tokens.length > 0;
  };
  if (keyPaths !== undefined && !(Array.isArray(keyPaths) && keyPaths.every(isKeyPath))) {
    return `${functionName}.macro.unmarked_key_paths must be a list of JSONPaths`;
  }
  if (entry.return !== undefined) return `${functionName} is a macro, so it takes no return`;
  return macroRolesProblem(functionName, macro, entry.arguments);
}

function alternativesText(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function kindOfRoleField(field) {
  return MACRO_KINDS.find((kind) => MACRO_ROLES[kind].some((role) => role.field === field));
}

function macroRolesProblem(functionName, macro, parameters) {
  const roles = MACRO_ROLES[macro.kind];
  const roleFields = MACRO_KINDS.flatMap((kind) => MACRO_ROLES[kind].map((role) => role.field));
  const foreignField = roleFields.find((field) => macro[field] !== undefined && !roles.some((role) => role.field === field));
  if (foreignField) return `${functionName}.macro.${foreignField} is read only on a ${kindOfRoleField(foreignField)} macro`;
  for (const role of roles) {
    const named = macro[role.field];
    if (named === undefined) {
      if (role.required) return `${functionName}.macro.${role.field} is required on a ${macro.kind} macro`;
      continue;
    }
    const parameter = parameters.find((candidate) => candidate.name === named);
    if (!parameter) return `${functionName}.macro.${role.field} must name one of ${functionName}'s arguments`;
    if (parameter.type !== 'any' && !role.types.includes(parameter.type)) {
      return `${functionName} argument ${named} is the ${role.field}, so its type is ${alternativesText(role.types)}`;
    }
  }
  const repeatableNames = roles.filter((role) => role.repeatable).map((role) => macro[role.field]);
  const repeated = parameters.find((parameter) => parameter.repeated && !repeatableNames.includes(parameter.name));
  return repeated ? `${functionName} argument ${repeated.name} is repeated, which only a merge macro's content may be` : null;
}

function macroRolesOf(macro) {
  const roles = MACRO_ROLES[macro.kind] || [];
  return Object.fromEntries(roles
    .filter((role) => macro[role.field] !== undefined)
    .map((role) => [role.role, macro[role.field]]));
}

function macroRoleParameterOf(entry, role) {
  const named = entry.macro && entry.macro.roles ? entry.macro.roles[role] : undefined;
  return named === undefined ? null : entry.arguments.find((parameter) => parameter.name === named) || null;
}

function bindsArgumentsByName(valueNode, parameters) {
  const names = parameters.map((parameter) => parameter.name);
  return Boolean(valueNode) && valueNode.kind === 'map' && valueNode.entries.some((entry) => names.includes(entry.key));
}

function macroArgumentNodesOf(valueNode, parameters) {
  const bound = new Map();
  const names = parameters.map((parameter) => parameter.name);
  if (bindsArgumentsByName(valueNode, parameters)) {
    for (const entry of valueNode.entries.filter((candidate) => names.includes(candidate.key))) {
      bound.set(entry.key, { node: entry.value, step: entry.key });
    }
  } else if (valueNode && valueNode.kind === 'seq' && parameters.length > 1) {
    valueNode.items.forEach((item, index) => {
      if (index < parameters.length) bound.set(names[index], { node: item, step: index });
    });
  } else if (parameters.length > 0) {
    bound.set(names[0], { node: valueNode, step: null });
  }
  return bound;
}

function macroArgumentValuesOf(value, parameters) {
  const bound = new Map();
  const names = parameters.map((parameter) => parameter.name);
  const isMap = value !== null && typeof value === 'object' && !Array.isArray(value);
  const byName = isMap && Object.keys(value).some((key) => names.includes(key));
  if (byName) {
    for (const [key, item] of Object.entries(value).filter(([candidate]) => names.includes(candidate))) {
      bound.set(key, { value: item, step: key });
    }
  } else if (Array.isArray(value) && parameters.length > 1) {
    value.forEach((item, index) => {
      if (index < parameters.length) bound.set(names[index], { value: item, step: index });
    });
  } else if (parameters.length > 0) {
    bound.set(names[0], { value, step: null });
  }
  return bound;
}

function macroRoleArgumentOf(bound, entry, role) {
  const named = entry.macro.roles[role];
  return named === undefined ? null : bound.get(named) || null;
}

function returnProblem(functionName, returned) {
  if (returned === undefined) return null;
  if (!returned || typeof returned !== 'object') return `${functionName}.return must be a mapping with type and description`;
  if (!ARGUMENT_TYPES.includes(returned.type)) {
    return `${functionName}.return.type must be one of ${ARGUMENT_TYPES.join(', ')}`;
  }
  if (!isNonEmptyText(returned.description)) return `${functionName}.return.description is required`;
  return null;
}

function tableProblem(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return 'is not a mapping of function names';
  for (const [functionName, entry] of Object.entries(table)) {
    if (!FUNCTION_NAME.test(functionName)) return `${functionName} is not a function name`;
    const problem = tableEntryProblem(functionName, entry);
    if (problem) return problem;
  }
  return null;
}

function macroOf(macro) {
  if (!macro) return null;
  return {
    kind: macro.kind,
    nameSuffixPattern: macro.name_suffix_pattern === undefined ? null : macro.name_suffix_pattern,
    unmarkedKeyPaths: (macro.unmarked_key_paths || []).map(parseAt),
    mergeBehavior: macro.merge_behavior === undefined ? null : macro.merge_behavior,
    roles: macroRolesOf(macro),
  };
}

function functionEntryOf(entry) {
  if (!Array.isArray(entry)) {
    return {
      description: entry.description,
      arguments: entry.arguments,
      return: entry.return || null,
      macro: macroOf(entry.macro),
    };
  }
  return {
    description: null,
    arguments: entry.map((parameter) => ({ ...parameter, description: null })),
    return: null,
    macro: null,
  };
}

function suffixExpressionOf(pattern) {
  if (!suffixExpressionsByPattern.has(pattern)) suffixExpressionsByPattern.set(pattern, new RegExp(`^(?:${pattern})$`));
  return suffixExpressionsByPattern.get(pattern);
}

function suffixMatches(entry, suffix) {
  const suffixPattern = entry.macro ? entry.macro.nameSuffixPattern : null;
  return suffixPattern === null ? suffix === '' : suffixExpressionOf(suffixPattern).test(suffix);
}

function calledEntryOf(table, functionName, standsAmongSiblings = false) {
  if (!table) return null;
  if (Object.hasOwn(table, functionName)) {
    const held = table[functionName];
    const entry = standsAmongSiblings && held.macroOfSameName ? held.macroOfSameName : held;
    if (suffixMatches(entry, '')) return { calledName: functionName, entry };
  }
  for (const [calledName, entry] of Object.entries(table)) {
    const suffixed = Boolean(entry.macro) && entry.macro.nameSuffixPattern !== null;
    if (!suffixed || !functionName.startsWith(calledName)) continue;
    if (suffixMatches(entry, functionName.slice(calledName.length))) return { calledName, entry };
  }
  return null;
}

function schemaVocabulary(schemaObject, pointer) {
  if (!schemaObject) return { vocabulary: null, problem: null, notice: null };
  const table = pointerTarget(schemaObject, pointer);
  if (table === undefined) return { vocabulary: null, problem: `the schema publishes no ${pointer}`, notice: null };
  const problem = tableProblem(table);
  if (problem) return { vocabulary: null, problem: `${pointer} ${problem}`, notice: null };
  const vocabulary = Object.fromEntries(Object.entries(table)
    .map(([functionName, entry]) => [functionName, functionEntryOf(entry)]));
  const notice = Object.values(table).some(Array.isArray)
    ? `${pointer} maps a function straight to its arguments, a deprecated form: `
      + 'map each function to its description, arguments and return'
    : null;
  return { vocabulary, problem: null, notice };
}

function arityText(parameters) {
  const minimum = parameters.filter((parameter) => parameter.required).length;
  const repeated = parameters.some((parameter) => parameter.repeated);
  if (repeated) return `${minimum} or more`;
  return minimum === parameters.length ? `${minimum}` : `${minimum} to ${parameters.length}`;
}

function signatureText(functionName, entry) {
  const argumentsText = entry.arguments.map((parameter) => {
    const optional = parameter.required ? '' : '?';
    const repeated = parameter.repeated ? '...' : '';
    return `${repeated}${parameter.name}${optional}: ${parameter.type}`;
  });
  const called = `${functionName}(${argumentsText.join(', ')})`;
  return entry.macro ? `macro ${called}` : `${called}: ${returnTypeOf(entry.return)}`;
}

function expansionLineOf(entry) {
  const nameOf = (role) => `\`${entry.macro.roles[role]}\``;
  const expansions = {
    function_call: () => (entry.macro.roles.calleeArguments
      ? `a call of the macro or function ${nameOf('callee')} names, ${nameOf('calleeArguments')} its arguments by name`
      : `a call of the macro or function ${nameOf('callee')} names`),
    merge: () => {
      const content = macroRoleParameterOf(entry, 'content');
      const contentText = content.type === 'text'
        ? `the content at ${nameOf('content')}`
        : `${nameOf('content')}${content.repeated ? ' in order' : ''}`;
      return `the map holding the call, ${MERGE_VERBS[entry.macro.mergeBehavior]} ${contentText}`;
    },
    loop: () => `${nameOf('body')} once per item of ${nameOf('collection')}, ${nameOf('loopVariable')} bound to the item`,
    transform: () => 'the map holding the call, rewritten by the macro',
  };
  return `*Expands to:* ${expansions[entry.macro.kind]()}.`;
}

function returnTypeOf(returned) {
  return returned ? returned.type : VOID_RETURN_TYPE;
}

function returnLineOf(returned) {
  return `*Returns:* ${returned && returned.description ? returned.description : `\`${returnTypeOf(returned)}\``}`;
}

function functionDocumentationOf(functionName, entry) {
  const sections = [`\`\`\`${SIGNATURE_LANGUAGE}\n${signatureText(functionName, entry)}\n\`\`\``];
  if (entry.description) sections.push(entry.description);
  const argumentLines = entry.arguments
    .filter((parameter) => parameter.description)
    .map((parameter) => `- \`${parameter.name}\`: ${parameter.description}`);
  if (argumentLines.length > 0) sections.push(argumentLines.join('\n'));
  sections.push(entry.macro ? expansionLineOf(entry) : returnLineOf(entry.return));
  return sections.join('\n\n');
}

function literalTypeProblem(node, type, isExpression) {
  if (type === 'any' || !node) return null;
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string' && isExpression(node.value)) return null;
    const matches = {
      text: typeof node.value === 'string',
      function: typeof node.value === 'string',
      macro: typeof node.value === 'string',
      number: typeof node.value === 'number',
      whole_number: Number.isInteger(node.value),
      boolean: typeof node.value === 'boolean',
      list: false,
      map: false,
    };
    return matches[type] ? null : `expects ${type}`;
  }
  if (node.kind === 'map') {
    const [entry] = node.entries;
    const isExpressionEntry = node.entries.length === 1 && entry.key && isExpression(entry.key, true, entry.value);
    return isExpressionEntry || type === 'map' ? null : `expects ${type}`;
  }
  if (node.kind === 'seq') return type === 'list' ? null : `expects ${type}`;
  return null;
}

function argumentNodesOf(call, parameters, argumentsByTable) {
  if (call.splat) return call.value && call.value.kind === 'seq' ? call.value.items : null;
  const takesOneArgument = parameters.length === 1 && !parameters[0].repeated;
  if (!argumentsByTable || takesOneArgument || !call.value || call.value.kind !== 'seq') return [call.value];
  return call.value.items;
}

function argumentProblems(call, calledName, parameters, isExpression, argumentsByTable) {
  const problems = [];
  const argumentNodes = argumentNodesOf(call, parameters, argumentsByTable);
  if (!argumentNodes) {
    return [{
      range: call.keyRange,
      message: `${calledName} with the splat operator needs a list of arguments`,
    }];
  }
  const minimum = parameters.filter((parameter) => parameter.required).length;
  const repeated = parameters.some((parameter) => parameter.repeated);
  if (argumentNodes.length < minimum || (!repeated && argumentNodes.length > parameters.length)) {
    const given = argumentNodes.length;
    problems.push({
      range: call.functionRange,
      message: `${calledName} takes ${arityText(parameters)} arguments, given ${given}`,
    });
    return problems;
  }
  argumentNodes.forEach((node, index) => {
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    const typeProblem = literalTypeProblem(node, parameter.type, isExpression);
    if (typeProblem && node) {
      problems.push({ range: node.range, message: `${calledName} argument ${parameter.name} ${typeProblem}` });
    }
  });
  return problems;
}

function tableEntryKindOf(entry) {
  return entry.macro ? 'macro' : 'function';
}

function entriesNamedIn(held) {
  if (!held) return { functionEntry: null, macroEntry: null };
  if (held.macro) return { functionEntry: null, macroEntry: held };
  const { macroOfSameName, ...functionEntry } = held;
  return { functionEntry, macroEntry: macroOfSameName || null };
}

function unitedTableOf(tables) {
  const united = {};
  for (const table of tables) {
    for (const [functionName, entry] of Object.entries(table)) {
      const named = entriesNamedIn(Object.hasOwn(united, functionName) ? united[functionName] : null);
      const functionEntry = entry.macro ? named.functionEntry : entry;
      const macroEntry = entry.macro ? entry : named.macroEntry;
      united[functionName] = functionEntry && macroEntry
        ? { ...functionEntry, macroOfSameName: macroEntry }
        : functionEntry || macroEntry;
    }
  }
  return united;
}

function tableEntriesOf(table) {
  return Object.entries(table).flatMap(([functionName, held]) => {
    const { functionEntry, macroEntry } = entriesNamedIn(held);
    return [functionEntry, macroEntry].filter(Boolean).map((entry) => [functionName, entry]);
  });
}

function isFunctionCallMacro(called) {
  return Boolean(called) && Boolean(called.entry.macro) && called.entry.macro.kind === 'function_call';
}

function functionCallNodesOf(call) {
  return call.value && call.value.kind === 'seq' ? call.value.items : [call.value];
}

function functionCallPartsOf(callNode, entry) {
  const bound = macroArgumentNodesOf(callNode, entry.arguments);
  const nodeOf = (role) => {
    const argument = macroRoleArgumentOf(bound, entry, role);
    return argument ? argument.node : null;
  };
  return { calleeNode: nodeOf('callee'), argumentsNode: nodeOf('calleeArguments') };
}

function calleeNamesOf(call, entry) {
  return functionCallNodesOf(call)
    .map((callNode) => functionCallPartsOf(callNode, entry).calleeNode)
    .filter((node) => node && node.kind === 'scalar' && typeof node.value === 'string')
    .map((node) => ({ name: node.value, range: node.range }));
}

function calleeWrittenAt(call, entry, position) {
  const afterKey = (keyRange) => keyRange.end.line === position.line && keyRange.end.character < position.character;
  if (!call.value || call.value.kind === 'scalar') return afterKey(call.keyRange);
  const calleeParameter = macroRoleParameterOf(entry, 'callee');
  return functionCallNodesOf(call).some((callNode) => {
    if (!callNode) return false;
    if (callNode.kind === 'scalar') return contains(callNode.range, position);
    if (callNode.kind !== 'map') return false;
    return callNode.entries.some((item) => item.key === calleeParameter.name && afterKey(item.keyRange));
  });
}

function namedArgumentProblems(argumentsNode, parameters, ownerName, anchorRange, isExpression) {
  const problems = [];
  const items = argumentsNode && argumentsNode.kind === 'map' ? argumentsNode.entries : [];
  const parameterNames = parameters.map((parameter) => parameter.name);
  for (const item of items.filter((candidate) => !parameterNames.includes(candidate.key))) {
    problems.push({ range: item.keyRange, message: `${ownerName} has no argument ${item.key}` });
  }
  for (const parameter of parameters) {
    const item = items.find((candidate) => candidate.key === parameter.name);
    if (!item) {
      if (parameter.required) {
        problems.push({ range: anchorRange, message: `${ownerName} needs argument ${parameter.name}` });
      }
      continue;
    }
    const typeProblem = literalTypeProblem(item.value, parameter.type, isExpression);
    if (typeProblem && item.value) {
      problems.push({ range: item.value.range, message: `${ownerName} argument ${parameter.name} ${typeProblem}` });
    }
  }
  return problems;
}

function functionCallProblems(call, called, table, isExpression) {
  const { calledName, entry } = called;
  const calleeParameter = macroRoleParameterOf(entry, 'callee');
  const problems = [];
  for (const callNode of functionCallNodesOf(call)) {
    const absent = !callNode || (callNode.kind === 'scalar' && callNode.value === null);
    const anchorRange = absent ? call.keyRange : callNode.range;
    if (absent || callNode.kind === 'map') {
      problems.push(...namedArgumentProblems(callNode, entry.arguments, calledName, anchorRange, isExpression));
    } else {
      const typeProblem = literalTypeProblem(callNode, calleeParameter.type, isExpression);
      if (typeProblem) {
        const message = `${calledName} argument ${calleeParameter.name} ${typeProblem}`;
        problems.push({ range: callNode.range, message });
      }
    }
    const { calleeNode, argumentsNode } = functionCallPartsOf(callNode, entry);
    const calleeName = calleeNode && calleeNode.kind === 'scalar' ? calleeNode.value : null;
    const calleeIsMacro = calleeParameter.type === 'macro';
    const callee = typeof calleeName === 'string' ? calledEntryOf(table, calleeName, calleeIsMacro) : null;
    const namesOtherKind = Boolean(callee) && ENTRY_NAME_TYPES.includes(calleeParameter.type)
      && tableEntryKindOf(callee.entry) !== calleeParameter.type;
    if (namesOtherKind) {
      const message = `${calledName} argument ${calleeParameter.name} expects ${calleeParameter.type}`;
      problems.push({ range: calleeNode.range, message });
    }
    if (!callee || (argumentsNode && argumentsNode.kind !== 'map')) continue;
    problems.push(...namedArgumentProblems(
      argumentsNode,
      callee.entry.arguments,
      callee.calledName,
      calleeNode.range,
      isExpression,
    ));
  }
  return problems;
}

function standsAmongSiblings(call) {
  return call.name === null && call.siblingCount > 1;
}

function callProblems(calls, functionConfig, vocabulary, isExpression) {
  const { table, complete } = vocabulary;
  const problems = [];
  const callsWithoutNameAllowed = Boolean(functionConfig.markerFunction)
    && functionConfig.markerFunction.callsWithoutNameAllowed;
  const argumentsByTable = Boolean(functionConfig.markerFunction) && functionConfig.markerFunction.splatOperator === null;
  for (const call of calls) {
    const refused = functionConfig.callsNotAllowedAt
      .find((entry) => pathMatches(entry.tokens, call.documentPath, entry));
    if (refused) {
      problems.push({ range: call.keyRange, message: `a function call is not allowed at this key` });
      continue;
    }
    const called = calledEntryOf(table, call.functionName, standsAmongSiblings(call));
    const standsAsKey = Boolean(called && called.entry.macro);
    if (!standsAsKey && call.name === null && !callsWithoutNameAllowed) {
      problems.push({ range: call.keyRange, message: 'a function call needs a name before it' });
      continue;
    }
    if (!standsAsKey && call.name === null && call.siblingCount > 1) {
      problems.push({ range: call.keyRange, message: 'a call with no name must be the only key of its map' });
      continue;
    }
    if (!called) {
      if (complete) problems.push({ range: call.functionRange, message: `unknown function ${call.functionName}` });
      continue;
    }
    if (isFunctionCallMacro(called)) {
      problems.push(...functionCallProblems(call, called, table, isExpression));
      continue;
    }
    const { calledName, entry } = called;
    if (entry.macro && bindsArgumentsByName(call.value, entry.arguments)) {
      const named = namedArgumentProblems(call.value, entry.arguments, calledName, call.functionRange, isExpression);
      problems.push(...named);
      continue;
    }
    problems.push(...argumentProblems(call, calledName, entry.arguments, isExpression, argumentsByTable));
  }
  return problems;
}

module.exports = {
  ARGUMENT_TYPES,
  parseFunctionKey,
  collectCalls,
  terraformVocabulary,
  schemaVocabulary,
  signatureText,
  functionDocumentationOf,
  calledEntryOf,
  isFunctionCallMacro,
  tableEntryKindOf,
  unitedTableOf,
  tableEntriesOf,
  standsAmongSiblings,
  calleeNamesOf,
  calleeWrittenAt,
  unmarkedCallsOf,
  callProblems,
  macroRoleParameterOf,
  macroArgumentNodesOf,
  macroArgumentValuesOf,
  macroRoleArgumentOf,
};

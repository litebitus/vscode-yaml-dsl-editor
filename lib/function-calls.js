const { rangeBetween } = require('./range');
const { pathMatches } = require('./document-path');

const ARGUMENT_TYPES = ['text', 'number', 'whole_number', 'boolean', 'list', 'map', 'any'];
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_:]*$/;

function parseFunctionKey(key, markerFunction) {
  if (!markerFunction || typeof key !== 'string') return null;
  const { callMarker, splatOperator } = markerFunction;
  const lastSpace = key.trimEnd().lastIndexOf(' ');
  const callStart = lastSpace + 1;
  const callText = key.slice(callStart).trimEnd();
  if (!callText.startsWith(callMarker)) return null;
  const splat = callText.endsWith(splatOperator);
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
          const absolute = (offset) => entry.keyStart + offset;
          calls.push({
            ...parsed,
            documentPath: entryPath,
            keyRange: entry.keyRange,
            markerRange: rangeBetween(text, absolute(parsed.markerStart), absolute(parsed.nameStart)),
            functionRange: rangeBetween(text, absolute(parsed.nameStart), absolute(parsed.nameEnd)),
            splatRange: rangeBetween(text, absolute(parsed.nameEnd), absolute(parsed.callEnd)),
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
    }));
    if (signature.variadic_parameter) {
      parameters.push({
        name: signature.variadic_parameter.name,
        type: terraformType(signature.variadic_parameter.type),
        required: false,
        repeated: true,
      });
    }
    vocabulary[functionName] = parameters;
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

function tableProblem(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return 'is not a mapping of function names';
  for (const [functionName, parameters] of Object.entries(table)) {
    if (!FUNCTION_NAME.test(functionName)) return `${functionName} is not a function name`;
    if (!Array.isArray(parameters)) return `${functionName} is not a list of arguments`;
    let optionalSeen = false;
    for (const [index, parameter] of parameters.entries()) {
      const label = `${functionName}[${index}]`;
      if (!parameter || typeof parameter.name !== 'string' || parameter.name === '') return `${label}.name is required`;
      if (!ARGUMENT_TYPES.includes(parameter.type)) return `${label}.type must be one of ${ARGUMENT_TYPES.join(', ')}`;
      if (typeof parameter.required !== 'boolean') return `${label}.required must be true or false`;
      if (typeof parameter.repeated !== 'boolean') return `${label}.repeated must be true or false`;
      if (parameter.repeated && index !== parameters.length - 1) return `${label} repeats but is not the last argument`;
      if (parameter.required && optionalSeen) return `${label} is required after an optional argument`;
      if (!parameter.required) optionalSeen = true;
    }
  }
  return null;
}

function schemaVocabulary(schemaObject, pointer) {
  if (!schemaObject) return { vocabulary: null, problem: null };
  const table = pointerTarget(schemaObject, pointer);
  if (table === undefined) return { vocabulary: null, problem: `the schema publishes no ${pointer}` };
  const problem = tableProblem(table);
  return problem ? { vocabulary: null, problem: `${pointer} ${problem}` } : { vocabulary: table, problem: null };
}

function arityText(parameters) {
  const minimum = parameters.filter((parameter) => parameter.required).length;
  const repeated = parameters.some((parameter) => parameter.repeated);
  if (repeated) return `${minimum} or more`;
  return minimum === parameters.length ? `${minimum}` : `${minimum} to ${parameters.length}`;
}

function signatureText(functionName, parameters) {
  const argumentsText = parameters.map((parameter) => {
    const optional = parameter.required ? '' : '?';
    const repeated = parameter.repeated ? '...' : '';
    return `${repeated}${parameter.name}${optional}: ${parameter.type}`;
  });
  return `${functionName}(${argumentsText.join(', ')})`;
}

function literalTypeProblem(node, type, isExpression) {
  if (type === 'any' || !node) return null;
  if (node.kind === 'scalar') {
    if (typeof node.value === 'string' && isExpression(node.value)) return null;
    const matches = {
      text: typeof node.value === 'string',
      number: typeof node.value === 'number',
      whole_number: Number.isInteger(node.value),
      boolean: typeof node.value === 'boolean',
      list: false,
      map: false,
    };
    return matches[type] ? null : `expects ${type}`;
  }
  if (node.kind === 'map') {
    const isCall = node.entries.length === 1 && node.entries[0].key && isExpression(node.entries[0].key, true);
    return isCall || type === 'map' ? null : `expects ${type}`;
  }
  if (node.kind === 'seq') return type === 'list' ? null : `expects ${type}`;
  return null;
}

function argumentProblems(call, parameters, isExpression) {
  const problems = [];
  let argumentNodes;
  if (call.splat) {
    if (!call.value || call.value.kind !== 'seq') {
      return [{
        range: call.keyRange,
        message: `${call.functionName} with the splat operator needs a list of arguments`,
      }];
    }
    argumentNodes = call.value.items;
  } else {
    argumentNodes = [call.value];
  }
  const minimum = parameters.filter((parameter) => parameter.required).length;
  const repeated = parameters.some((parameter) => parameter.repeated);
  if (argumentNodes.length < minimum || (!repeated && argumentNodes.length > parameters.length)) {
    const given = argumentNodes.length;
    problems.push({
      range: call.functionRange,
      message: `${call.functionName} takes ${arityText(parameters)} arguments, given ${given}`,
    });
    return problems;
  }
  argumentNodes.forEach((node, index) => {
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    const typeProblem = literalTypeProblem(node, parameter.type, isExpression);
    if (typeProblem && node) {
      problems.push({ range: node.range, message: `${call.functionName} argument ${parameter.name} ${typeProblem}` });
    }
  });
  return problems;
}

function callProblems(calls, functionConfig, vocabulary, isExpression) {
  const { table, complete } = vocabulary;
  const problems = [];
  const callsWithoutNameAllowed = Boolean(functionConfig.markerFunction)
    && functionConfig.markerFunction.callsWithoutNameAllowed;
  for (const call of calls) {
    const refused = functionConfig.callsNotAllowedAt
      .find((entry) => pathMatches(entry.tokens, call.documentPath, entry));
    if (refused) {
      problems.push({ range: call.keyRange, message: `a function call is not allowed at this key` });
      continue;
    }
    if (call.name === null && !callsWithoutNameAllowed) {
      problems.push({ range: call.keyRange, message: 'a function call needs a name before it' });
      continue;
    }
    if (call.name === null && call.siblingCount > 1) {
      problems.push({ range: call.keyRange, message: 'a call with no name must be the only key of its map' });
      continue;
    }
    const parameters = table[call.functionName];
    if (!parameters) {
      if (complete) problems.push({ range: call.functionRange, message: `unknown function ${call.functionName}` });
      continue;
    }
    problems.push(...argumentProblems(call, parameters, isExpression));
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
  callProblems,
};

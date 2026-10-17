const { rangeBetween } = require('./range');
const { pathMatches } = require('./document-path');

const ARGUMENT_TYPES = ['text', 'number', 'whole_number', 'boolean', 'list', 'map', 'any'];
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_:]*$/;
const VOID_RETURN_TYPE = 'void';

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
    || returnProblem(functionName, entry.return);
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

function functionEntryOf(entry) {
  if (!Array.isArray(entry)) {
    return { description: entry.description, arguments: entry.arguments, return: entry.return || null };
  }
  return { description: null, arguments: entry.map((parameter) => ({ ...parameter, description: null })), return: null };
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
  return `${functionName}(${argumentsText.join(', ')}): ${returnTypeOf(entry.return)}`;
}

function returnTypeOf(returned) {
  return returned ? returned.type : VOID_RETURN_TYPE;
}

function returnLineOf(returned) {
  return `*Returns:* ${returned && returned.description ? returned.description : `\`${returnTypeOf(returned)}\``}`;
}

function functionDocumentationOf(functionName, entry) {
  const sections = [`\`\`\`\n${signatureText(functionName, entry)}\n\`\`\``];
  if (entry.description) sections.push(entry.description);
  const argumentLines = entry.arguments
    .filter((parameter) => parameter.description)
    .map((parameter) => `- \`${parameter.name}\`: ${parameter.description}`);
  if (argumentLines.length > 0) sections.push(argumentLines.join('\n'));
  sections.push(returnLineOf(entry.return));
  return sections.join('\n\n');
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

function argumentProblems(call, parameters, isExpression, argumentsByTable) {
  const problems = [];
  const argumentNodes = argumentNodesOf(call, parameters, argumentsByTable);
  if (!argumentNodes) {
    return [{
      range: call.keyRange,
      message: `${call.functionName} with the splat operator needs a list of arguments`,
    }];
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
  const argumentsByTable = Boolean(functionConfig.markerFunction) && functionConfig.markerFunction.splatOperator === null;
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
    const entry = table[call.functionName];
    if (!entry) {
      if (complete) problems.push({ range: call.functionRange, message: `unknown function ${call.functionName}` });
      continue;
    }
    problems.push(...argumentProblems(call, entry.arguments, isExpression, argumentsByTable));
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
  callProblems,
};

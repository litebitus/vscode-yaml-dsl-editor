const REGEX_SYNTAX = new Set(['[', ']', '(', ')', '*', '+', '?', '|', '.', '^', '$', '{', '}']);

function groupEnd(pattern, openIndex) {
  let depth = 0;
  let inClass = false;
  for (let index = openIndex; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function leadingLiteral(rule) {
  const pattern = String(rule.pattern || '').replace(/^\^/, '');
  let literalText = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if ('*+?{'.includes(character)) return literalText.slice(0, -1);
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) break;
      literalText += escaped;
      index += 1;
      continue;
    }
    if (REGEX_SYNTAX.has(character)) break;
    literalText += character;
  }
  return literalText;
}

function templateFor(rule) {
  let pattern = String(rule.pattern || '');
  if (pattern.startsWith('^')) pattern = pattern.slice(1);
  if (pattern.endsWith('$') && !pattern.endsWith('\\$')) pattern = pattern.slice(0, -1);
  const pieces = [];
  let literalText = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) return null;
      literalText += escaped;
      index += 1;
      continue;
    }
    const namedGroup = pattern.slice(index).match(/^\(\?<([A-Za-z_][A-Za-z0-9_]*)>/);
    if (namedGroup) {
      const closeIndex = groupEnd(pattern, index);
      if (closeIndex < 0) return null;
      if (literalText) pieces.push({ literalText });
      literalText = '';
      pieces.push({ group: namedGroup[1] });
      index = closeIndex;
      continue;
    }
    if (REGEX_SYNTAX.has(character)) return null;
    literalText += character;
  }
  if (literalText) pieces.push({ literalText });
  const groupKeys = {};
  for (const [key, group] of Object.entries(rule.target || {})) {
    if (key !== 'kind') groupKeys[group] = key;
  }
  if (pieces.some((piece) => piece.group && !groupKeys[piece.group])) return null;
  const leadingText = pieces.length && pieces[0].literalText ? pieces[0].literalText : '';
  if (!leadingText) return null;
  return { rule, pieces, groupKeys, leadingText };
}

function symbolValue(symbol, key) {
  return key === 'name' ? symbol.name : (symbol.qualifiers || {})[key];
}

function fillTemplate(template, symbol) {
  if (symbol.kind !== template.rule.target.kind) return null;
  let referenceText = '';
  const groupValues = {};
  for (const piece of template.pieces) {
    if (piece.literalText) {
      referenceText += piece.literalText;
      continue;
    }
    const value = symbolValue(symbol, template.groupKeys[piece.group]);
    if (typeof value !== 'string' || value === '') return null;
    groupValues[piece.group] = value;
    referenceText += value;
  }
  const match = referenceText.match(new RegExp(template.rule.pattern));
  if (!match || match.index !== 0) return null;
  if (template.rule.where !== 'whole' && match[0] !== referenceText) return null;
  const readBack = match.groups || {};
  if (Object.entries(groupValues).some(([group, value]) => readBack[group] !== value)) return null;
  return referenceText;
}

module.exports = { leadingLiteral, templateFor, fillTemplate };

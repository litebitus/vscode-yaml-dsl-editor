const { ANYWHERE_IN_SCALAR } = require('./reference-positions');

const REGEX_SYNTAX =new Set(['[', ']', '(', ')', '*', '+', '?', '|', '.', '^', '$', '{', '}']);

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

const QUANTIFIERS = '*+?{';

function classMembersAt(pattern, openIndex) {
  if (pattern[openIndex + 1] === '^') return null;
  const characters = [];
  let index = openIndex + 1;
  for (; index < pattern.length && pattern[index] !== ']'; index += 1) {
    if (pattern[index] !== '\\') {
      characters.push(pattern[index]);
      continue;
    }
    const escaped = pattern[index + 1];
    if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) return null;
    characters.push(escaped);
    index += 1;
  }
  if (index >= pattern.length) return null;
  const members = [];
  for (let position = 0; position < characters.length; position += 1) {
    const isRange = characters[position + 1] === '-' && position + 2 < characters.length;
    if (!isRange) {
      members.push(characters[position]);
      continue;
    }
    const first = characters[position].codePointAt(0);
    const last = characters[position + 2].codePointAt(0);
    for (let code = first; code <= last; code += 1) members.push(String.fromCodePoint(code));
    position += 2;
  }
  return { members: [...new Set(members)], closeIndex: index };
}

function withLiteral(pieces, text) {
  const last = pieces[pieces.length - 1];
  return last && last.literalText !== undefined
    ? [...pieces.slice(0, -1), { literalText: last.literalText + text }]
    : [...pieces, { literalText: text }];
}

function templateOfPieces(rule, pieces, leadingTextRequired) {
  const groupKeys = {};
  if (rule.nameGroup) groupKeys[rule.nameGroup] = 'name';
  if (rule.scopeGroup) groupKeys[rule.scopeGroup] = 'scope';
  if (pieces.some((piece) => piece.group && !groupKeys[piece.group])) return null;
  const leadingText = pieces.length && pieces[0].literalText ? pieces[0].literalText : '';
  if (!leadingText && leadingTextRequired) return null;
  return { rule, pieces, groupKeys, leadingText };
}

function templatesFor(rule, { leadingTextRequired = true } = {}) {
  let pattern = String(rule.pattern || '');
  if (pattern.startsWith('^')) pattern = pattern.slice(1);
  if (pattern.endsWith('$') && !pattern.endsWith('\\$')) pattern = pattern.slice(0, -1);
  let alternatives = [[]];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) return [];
      alternatives = alternatives.map((pieces) => withLiteral(pieces, escaped));
      index += 1;
      continue;
    }
    if (character === '[') {
      const characterClass = classMembersAt(pattern, index);
      if (!characterClass || QUANTIFIERS.includes(pattern[characterClass.closeIndex + 1])) return [];
      alternatives = alternatives.flatMap((pieces) => (
        characterClass.members.map((member) => withLiteral(pieces, member))
      ));
      index = characterClass.closeIndex;
      continue;
    }
    const namedGroup = pattern.slice(index).match(/^\(\?<([A-Za-z_][A-Za-z0-9_]*)>/);
    if (namedGroup) {
      const closeIndex = groupEnd(pattern, index);
      if (closeIndex < 0) return [];
      alternatives = alternatives.map((pieces) => [...pieces, { group: namedGroup[1] }]);
      index = closeIndex;
      continue;
    }
    if (REGEX_SYNTAX.has(character)) return [];
    alternatives = alternatives.map((pieces) => withLiteral(pieces, character));
  }
  return alternatives
    .map((pieces) => templateOfPieces(rule, pieces, leadingTextRequired))
    .filter((template) => template !== null);
}

function templateFor(rule, options) {
  return templatesFor(rule, options)[0] || null;
}

function symbolValue(symbol, key) {
  return key === 'name' ? symbol.name : symbol.scope;
}

function fillTemplate(template, symbol) {
  const { scopeName, scopeGroup } = template.rule;
  if (symbol.scopeName !== scopeName) return null;
  if (!scopeGroup && symbol.scope !== scopeName) return null;
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
  if (!match || match.index !== 0 || match[0] !== referenceText) return null;
  const readBack = match.groups || {};
  if (Object.entries(groupValues).some(([group, value]) => readBack[group] !== value)) return null;
  return referenceText;
}

const PLACEHOLDER_SCOPE = 'placeholder';

function placeholderShapesOf(placeholder) {
  return templatesFor({
    pattern: placeholder.pattern,
    positions: [ANYWHERE_IN_SCALAR],
    scopeName: PLACEHOLDER_SCOPE,
    scopeGroup: null,
    nameGroup: 'body',
  });
}

function wrapInPlaceholder(shape, bodyText) {
  return fillTemplate(shape, { scope: PLACEHOLDER_SCOPE, scopeName: PLACEHOLDER_SCOPE, name: bodyText });
}

module.exports = {
  leadingLiteral,
  templateFor,
  templatesFor,
  fillTemplate,
  placeholderShapesOf,
  wrapInPlaceholder,
};

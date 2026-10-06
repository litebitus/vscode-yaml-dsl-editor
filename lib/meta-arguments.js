function splitArguments(text) {
  const pieces = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[' || character === '(') depth += 1;
    else if (character === ']' || character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      pieces.push({ text: text.slice(start, index), start });
      start = index + 1;
    }
  }
  pieces.push({ text: text.slice(start), start });
  return pieces;
}

function unquoted(text) {
  const trimmed = text.trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]);
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function argumentValues(valueText, valueStart) {
  const leading = valueText.length - valueText.trimStart().length;
  const trimmed = valueText.trim();
  if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return [{ value: unquoted(trimmed), start: valueStart + leading, end: valueStart + leading + trimmed.length }];
  }
  const listStart = valueStart + leading + 1;
  return splitArguments(trimmed.slice(1, -1))
    .filter((item) => item.text.trim() !== '')
    .map((item) => {
      const itemLeading = item.text.length - item.text.trimStart().length;
      const itemText = item.text.trim();
      const start = listStart + item.start + itemLeading;
      return { value: unquoted(itemText), start, end: start + itemText.length };
    });
}

function metaArgumentValues(key, argumentName) {
  const open = key.indexOf('(');
  if (open <= 0 || !key.trimEnd().endsWith(')')) return [];
  const close = key.lastIndexOf(')');
  const argumentsText = key.slice(open + 1, close);
  for (const piece of splitArguments(argumentsText)) {
    const equals = piece.text.indexOf('=');
    if (equals < 0) continue;
    if (piece.text.slice(0, equals).trim() !== argumentName) continue;
    return argumentValues(piece.text.slice(equals + 1), open + 1 + piece.start + equals + 1);
  }
  return [];
}

module.exports = { metaArgumentValues };

function contains(range, position) {
  if (!range || !position) return false;
  const { start, end } = range;
  if (position.line < start.line || position.line > end.line) return false;
  if (position.line === start.line && position.character < start.character) return false;
  if (position.line === end.line && position.character >= end.character) return false;
  return true;
}

function indexToPos(text, index) {
  const capped = Math.max(0, Math.min(index, text.length));
  let line = 0;
  let start = 0;
  for (let i = 0; i < capped; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      start = i + 1;
    }
  }
  return { line, character: capped - start };
}

function rangeBetween(text, start, end) {
  return { start: indexToPos(text, start), end: indexToPos(text, end) };
}

function zeroRange() {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

module.exports = { contains, indexToPos, rangeBetween, zeroRange };

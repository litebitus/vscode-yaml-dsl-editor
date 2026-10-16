const SYNTAX_CHARACTERS = new Set([...'^$\\.*+?()[]{}|/']);
const ESCAPE_LETTERS = new Set([...'dDwWsSbBnrtvfcxuk0123456789pP']);

function unicodeProblemOf(pattern) {
  try {
    RegExp(pattern, 'u');
    return null;
  } catch (error) {
    return error.message.replace(/^.*: /, '');
  }
}

function withoutIdentityEscapes(pattern) {
  let written = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      const escaped = pattern[index + 1];
      const kept = SYNTAX_CHARACTERS.has(escaped) || ESCAPE_LETTERS.has(escaped) || (inClass && escaped === '-');
      written += kept ? `\\${escaped}` : escaped;
      index += 1;
      continue;
    }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    written += character;
  }
  return written;
}

function unicodePatternOf(pattern) {
  const problem = unicodeProblemOf(pattern);
  if (problem === null) return { pattern, problem: null };
  const unescaped = withoutIdentityEscapes(pattern);
  if (unicodeProblemOf(unescaped) === null) return { pattern: unescaped, problem: null };
  return { pattern: null, problem };
}

module.exports = { unicodePatternOf, withoutIdentityEscapes };

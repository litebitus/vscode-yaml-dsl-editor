function parseAt(at) {
  if (typeof at !== 'string' || !at.startsWith('$')) return null;
  const tokens = [];
  let index = 1;
  while (index < at.length) {
    if (at[index] === '.') {
      index += 1;
      if (at[index] === '*') {
        tokens.push({ kind: 'star' });
        index += 1;
        continue;
      }
      let key = '';
      while (index < at.length && at[index] !== '.' && at[index] !== '[') {
        key += at[index];
        index += 1;
      }
      if (!key) return null;
      tokens.push({ kind: 'key', key });
      continue;
    }
    if (at.startsWith('[*]', index)) {
      tokens.push({ kind: 'index' });
      index += 3;
      continue;
    }
    return null;
  }
  return tokens;
}

function stepMatches(token, step, skipKeys) {
  if (token.kind === 'key') return step === token.key;
  if (token.kind === 'index') return typeof step === 'number';
  return typeof step === 'string' && !skipKeys.includes(step);
}

function pathMatches(tokens, documentPath, { skipKeys = [], includesSubtree = false } = {}) {
  if (documentPath.length < tokens.length) return false;
  if (!includesSubtree && documentPath.length !== tokens.length) return false;
  return tokens.every((token, index) => stepMatches(token, documentPath[index], skipKeys));
}

module.exports = { parseAt, pathMatches };

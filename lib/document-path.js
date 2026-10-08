const PATH_STEP_KINDS = {
  name: 'name',
  wildcard: 'wildcard',
  descendants: 'descendants',
};

function parseAt(at) {
  if (typeof at !== 'string' || !at.startsWith('$')) return null;
  const tokens = [];
  let index = 1;
  while (index < at.length) {
    if (tokens.length > 0 && tokens[tokens.length - 1].kind === PATH_STEP_KINDS.descendants) return null;
    if (at.startsWith('..*', index)) {
      tokens.push({ kind: PATH_STEP_KINDS.descendants });
      index += 3;
      continue;
    }
    if (at.startsWith('.*', index) || at.startsWith('[*]', index)) {
      tokens.push({ kind: PATH_STEP_KINDS.wildcard });
      index += at[index] === '.' ? 2 : 3;
      continue;
    }
    if (at[index] !== '.') return null;
    index += 1;
    let key = '';
    while (index < at.length && at[index] !== '.' && at[index] !== '[') {
      key += at[index];
      index += 1;
    }
    if (!key) return null;
    tokens.push({ kind: PATH_STEP_KINDS.name, key });
  }
  return tokens;
}

function selectableStep(step, skipKeys) {
  return typeof step === 'number' || !skipKeys.includes(step);
}

function pathMatches(tokens, documentPath, { skipKeys = [], includesSubtree = false } = {}) {
  const last = tokens[tokens.length - 1];
  const endsInDescendants = Boolean(last) && last.kind === PATH_STEP_KINDS.descendants;
  const fixedTokens = endsInDescendants ? tokens.slice(0, -1) : tokens;
  if (documentPath.length < fixedTokens.length + (endsInDescendants ? 1 : 0)) return false;
  if (!includesSubtree && !endsInDescendants && documentPath.length !== fixedTokens.length) return false;
  const fixedStepsMatch = fixedTokens.every((token, index) => {
    const step = documentPath[index];
    if (token.kind === PATH_STEP_KINDS.name) return step === token.key;
    return selectableStep(step, skipKeys);
  });
  if (!fixedStepsMatch) return false;
  if (!endsInDescendants) return true;
  return documentPath.slice(fixedTokens.length).every((step) => selectableStep(step, skipKeys));
}

module.exports = { PATH_STEP_KINDS, parseAt, pathMatches };

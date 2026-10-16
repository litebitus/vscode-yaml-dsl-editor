const PATH_STEP_KINDS = {
  name: 'name',
  descendantName: 'descendant_name',
  wildcard: 'wildcard',
  descendants: 'descendants',
};

const QUOTED_NAME_ESCAPES = { '\\': '\\', "'": "'", '"': '"' };

function quotedNameAt(at, start) {
  const quote = at[start + 1];
  if (at[start] !== '[' || (quote !== "'" && quote !== '"')) return null;
  let key = '';
  for (let index = start + 2; index < at.length; index += 1) {
    if (at[index] === quote) return at[index + 1] === ']' ? { key, next: index + 2 } : null;
    if (at[index] !== '\\') {
      key += at[index];
      continue;
    }
    const escaped = QUOTED_NAME_ESCAPES[at[index + 1]];
    if (escaped === undefined) return null;
    key += escaped;
    index += 1;
  }
  return null;
}

function bareNameAt(at, start) {
  let index = start;
  while (index < at.length && at[index] !== '.' && at[index] !== '[') index += 1;
  return index > start ? { key: at.slice(start, index), next: index } : null;
}

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
    const descending = at.startsWith('..', index);
    const nameStart = descending ? index + 2 : index;
    let name = null;
    if (at[nameStart] === '[') name = quotedNameAt(at, nameStart);
    else if (descending) name = bareNameAt(at, nameStart);
    else if (at[index] === '.') name = bareNameAt(at, index + 1);
    if (!name) return null;
    tokens.push({ kind: descending ? PATH_STEP_KINDS.descendantName : PATH_STEP_KINDS.name, key: name.key });
    index = name.next;
  }
  return tokens;
}

function selectableStep(step, skipKeys) {
  return typeof step === 'number' || !skipKeys.includes(step);
}

function pathMatches(tokens, documentPath, { skipKeys = [], includesSubtree = false } = {}) {
  const matchesFrom = (tokenIndex, pathIndex) => {
    if (tokenIndex === tokens.length) return includesSubtree || pathIndex === documentPath.length;
    const token = tokens[tokenIndex];
    if (token.kind === PATH_STEP_KINDS.descendants) {
      const below = documentPath.slice(pathIndex);
      return below.length > 0 && below.every((step) => selectableStep(step, skipKeys));
    }
    if (token.kind === PATH_STEP_KINDS.descendantName) {
      for (let index = pathIndex; index < documentPath.length; index += 1) {
        if (documentPath[index] === token.key && matchesFrom(tokenIndex + 1, index + 1)) return true;
        if (!selectableStep(documentPath[index], skipKeys)) return false;
      }
      return false;
    }
    if (pathIndex >= documentPath.length) return false;
    const step = documentPath[pathIndex];
    const stepMatches = token.kind === PATH_STEP_KINDS.name ? step === token.key : selectableStep(step, skipKeys);
    return stepMatches && matchesFrom(tokenIndex + 1, pathIndex + 1);
  };
  return matchesFrom(0, 0);
}

module.exports = { PATH_STEP_KINDS, parseAt, pathMatches };

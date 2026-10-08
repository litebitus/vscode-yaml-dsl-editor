function globToRegExp(glob) {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (glob.startsWith('**', index)) {
      pattern += '.*';
      index += 2;
      continue;
    }
    const char = glob[index];
    if (char === '*') pattern += '[^/]*';
    else if ('\\^$+?.()|[]{}'.includes(char)) pattern += `\\${char}`;
    else pattern += char;
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

const COMPILED_GLOBS_CAPACITY = 256;
const compiledGlobs = new Map();

function compiledGlobOf(glob) {
  if (compiledGlobs.has(glob)) return compiledGlobs.get(glob);
  const compiled = globToRegExp(glob);
  compiledGlobs.set(glob, compiled);
  if (compiledGlobs.size > COMPILED_GLOBS_CAPACITY) compiledGlobs.delete(compiledGlobs.keys().next().value);
  return compiled;
}

function matchGlob(glob, filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  return compiledGlobOf(glob).test(normalized);
}

function matchAny(globs, filePath) {
  return globs.some((glob) => matchGlob(glob, filePath));
}

module.exports = { globToRegExp, matchGlob, matchAny };

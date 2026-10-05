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

function matchGlob(glob, filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  return globToRegExp(glob).test(normalized);
}

function matchAny(globs, filePath) {
  return globs.some((glob) => matchGlob(glob, filePath));
}

module.exports = { globToRegExp, matchGlob, matchAny };

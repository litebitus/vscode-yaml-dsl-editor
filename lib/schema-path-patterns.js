const fs = require('fs');
const path = require('path');
const { matchGlob } = require('./glob');

function isPatternPath(schemaPath) {
  return schemaPath.includes('*');
}

function stepsOf(absolutePath) {
  return path.resolve(absolutePath).split(path.sep).filter(Boolean);
}

async function firstMatchingFile(patternPath, readDirectory = fs.promises.readdir) {
  let reached = [path.parse(path.resolve(patternPath)).root];
  for (const step of stepsOf(patternPath)) {
    if (!isPatternPath(step)) {
      reached = reached.map((folder) => path.join(folder, step));
      continue;
    }
    const matched = [];
    for (const folder of reached) {
      let names = [];
      try {
        names = await readDirectory(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (matchGlob(step, name)) matched.push(path.join(folder, name));
      }
    }
    reached = matched.sort();
  }
  for (const candidate of reached) {
    try {
      if ((await fs.promises.stat(candidate)).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function literalFolderOf(patternPath) {
  const steps = stepsOf(patternPath);
  const literal = steps.slice(0, steps.findIndex(isPatternPath));
  return path.join(path.parse(path.resolve(patternPath)).root, ...literal);
}

module.exports = { isPatternPath, firstMatchingFile, literalFolderOf };

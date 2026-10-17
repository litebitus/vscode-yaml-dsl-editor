function pathText(path) {
  return path.map(String).join('.');
}

function commonPrefixLength(paths) {
  const shortest = Math.min(...paths.map((path) => path.length));
  let length = 0;
  while (length < shortest - 1 && paths.every((path) => path[length] === paths[0][length])) length += 1;
  return length;
}

function factoredPathsText(paths) {
  if (paths.length === 1) return pathText(paths[0]);
  const prefixLength = commonPrefixLength(paths);
  const braced = `{${paths.map((path) => pathText(path.slice(prefixLength))).join(',')}}`;
  return prefixLength > 0 ? `${pathText(paths[0].slice(0, prefixLength))}.${braced}` : braced;
}

function mergeTargetTermsOf(targets) {
  const pathsByLabel = new Map();
  for (const { label, path } of targets) {
    if (!pathsByLabel.has(label)) pathsByLabel.set(label, []);
    const paths = pathsByLabel.get(label);
    if (!paths.some((held) => pathText(held) === pathText(path))) paths.push(path);
  }
  const groups = new Map();
  for (const [label, paths] of pathsByLabel) {
    const pathsKey = JSON.stringify(paths.map(pathText));
    if (!groups.has(pathsKey)) groups.set(pathsKey, { labels: [], paths });
    groups.get(pathsKey).labels.push(label);
  }
  return [...groups.values()].map(({ labels, paths }) => {
    const pathsText = factoredPathsText(paths);
    if (labels[0] === null) return pathsText;
    const labelsText = labels.length === 1 ? labels[0] : `{${labels.join(',')}}`;
    return `${labelsText}:${pathsText}`;
  });
}

module.exports = { mergeTargetTermsOf };

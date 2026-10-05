function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
  return copy;
}

// dict2 wins. Null deletes the key. An empty map deletes only while
// emptyMapDeletesDepth is still above zero; deeper, it merges.
function deepMerge(base, overlay, emptyMapDeletesDepth = 0) {
  const merged = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(overlay)) return merged;
  mergeInto(merged, overlay, emptyMapDeletesDepth);
  return merged;
}

function mergeInto(dict1, dict2, depth) {
  for (const [key, value] of Object.entries(dict2)) {
    const emptyDeletes = isPlainObject(value)
      && Object.keys(value).length === 0
      && Object.prototype.hasOwnProperty.call(dict1, key)
      && depth > 0;
    if (value === null || emptyDeletes) {
      delete dict1[key];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(dict1, key)
      && isPlainObject(dict1[key])
      && isPlainObject(value)) {
      mergeInto(dict1[key], value, depth - 1);
    } else {
      dict1[key] = clone(value);
    }
  }
}

module.exports = { deepMerge, isPlainObject, clone };

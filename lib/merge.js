function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyMap(value) {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
  return copy;
}

// dict2 wins. Null deletes the key. An empty map replaces the key's value.
function deepMerge(base, overlay) {
  const merged = isPlainObject(base) ? clone(base) : {};
  if (!isPlainObject(overlay)) return merged;
  mergeInto(merged, overlay);
  return merged;
}

function mergeInto(dict1, dict2) {
  for (const [key, value] of Object.entries(dict2)) {
    if (value === null) {
      delete dict1[key];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(dict1, key)
      && isPlainObject(dict1[key])
      && isPlainObject(value)
      && !isEmptyMap(value)) {
      mergeInto(dict1[key], value);
    } else {
      dict1[key] = clone(value);
    }
  }
}

function keepsBaseAt(overlay, path, inKey) {
  let node = overlay;
  for (let index = 0; index < path.length; index += 1) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, path[index])) return true;
    const value = node[path[index]];
    if (value === null) return false;
    if (index === path.length - 1) return inKey;
    if (!isPlainObject(value) || isEmptyMap(value) || typeof path[index + 1] === 'number') return false;
    node = value;
  }
  return true;
}

module.exports = { deepMerge, keepsBaseAt, isPlainObject, clone };

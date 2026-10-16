function keyOfTag(tagKeys, tag) {
  const found = (tagKeys || []).find((tagKey) => tagKey.tag === tag);
  return found ? found.key : null;
}

function tagOfKey(tagKeys, key) {
  const found = typeof key === 'string' ? (tagKeys || []).find((tagKey) => tagKey.key === key) : null;
  return found ? found.tag : null;
}

module.exports = { keyOfTag, tagOfKey };

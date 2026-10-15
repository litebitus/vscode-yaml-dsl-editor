const { pathMatches } = require('./document-path');

const KEY_SORT_ORDER_KINDS = { alphabetical: 'alphabetical', significance: 'significance' };

function keySortOrderFor(dsl, mapPath) {
  return (dsl.keySortOrders || []).find((entry) => pathMatches(entry.tokens, mapPath, entry)) || null;
}

function significanceRankOf(key, keySortOrder) {
  const firstIndex = keySortOrder.firstKeys.indexOf(key);
  if (firstIndex >= 0) return firstIndex;
  const lastIndex = keySortOrder.lastKeys.indexOf(key);
  if (lastIndex >= 0) return keySortOrder.firstKeys.length + 1 + lastIndex;
  return keySortOrder.firstKeys.length;
}

function sortedKeys(keysInWrittenOrder, keySortOrder) {
  if (!keySortOrder) return [...keysInWrittenOrder];
  if (keySortOrder.order === KEY_SORT_ORDER_KINDS.alphabetical) return [...keysInWrittenOrder].sort();
  const ranked = keysInWrittenOrder.map((key, index) => ({ key, index, rank: significanceRankOf(key, keySortOrder) }));
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return ranked.map((entry) => entry.key);
}

module.exports = { KEY_SORT_ORDER_KINDS, keySortOrderFor, significanceRankOf, sortedKeys };

const crypto = require('crypto');

const STACK_CAPACITY = 8;

function createCache() {
  const stacks = new Map();
  const schemas = new Map();
  let evicted = [];

  function note(ids) {
    evicted.push(...ids);
  }

  function evictableCount() {
    let count = 0;
    for (const entry of stacks.values()) {
      if (!entry.pinned && !entry.onScreen) count += 1;
    }
    return count;
  }

  function evict() {
    const removed = [];
    while (evictableCount() > STACK_CAPACITY) {
      let victim = null;
      for (const [id, entry] of stacks) {
        if (!entry.pinned && !entry.onScreen) {
          victim = id;
          break;
        }
      }
      if (!victim) break;
      stacks.delete(victim);
      removed.push(victim);
    }
    return removed;
  }

  function noteSchema(text, parseText) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    if (schemas.has(hash)) return hash;
    const parsedObject = parseText(text);
    if (!parsedObject) return null;
    schemas.set(hash, { hash, text, object: parsedObject });
    return hash;
  }

  function schemaObject(hash) {
    const entry = schemas.get(hash);
    return entry ? entry.object : null;
  }

  function hold(id, data, flags = {}) {
    const existing = stacks.get(id);
    const entry = {
      id,
      data,
      pinned: Object.prototype.hasOwnProperty.call(flags, 'pinned') ? flags.pinned : Boolean(existing && existing.pinned),
      onScreen: Object.prototype.hasOwnProperty.call(flags, 'onScreen') ? flags.onScreen : Boolean(existing && existing.onScreen),
    };
    stacks.delete(id);
    stacks.set(id, entry);
    note(evict());
    return entry;
  }

  function replaceData(id, data) {
    const entry = stacks.get(id);
    if (!entry) return null;
    entry.data = data;
    return entry;
  }

  function touch(id) {
    const entry = stacks.get(id);
    if (!entry) return null;
    stacks.delete(id);
    stacks.set(id, entry);
    return entry;
  }

  function setFlags(id, flags) {
    const entry = stacks.get(id);
    if (!entry) return;
    entry.pinned = flags.pinned;
    entry.onScreen = flags.onScreen;
  }

  function rebalance() {
    note(evict());
  }

  function get(id) {
    return stacks.get(id) || null;
  }

  function find(predicate) {
    for (const entry of stacks.values()) {
      if (predicate(entry)) return entry;
    }
    return null;
  }

  function entries() {
    return [...stacks.values()];
  }

  function ids() {
    return [...stacks.keys()];
  }

  function takeEvicted() {
    const out = evicted;
    evicted = [];
    return out;
  }

  return {
    noteSchema,
    schemaObject,
    schemaCount: () => schemas.size,
    hold,
    replaceData,
    touch,
    setFlags,
    rebalance,
    get,
    find,
    entries,
    ids,
    takeEvicted,
  };
}

module.exports = { createCache, STACK_CAPACITY };

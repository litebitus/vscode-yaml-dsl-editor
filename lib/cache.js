const crypto = require('crypto');

const DEFAULT_CACHE_CAPACITIES = { stackCapacity: 32, schemaCapacity: 32 };
const STACK_RECENCY = { mostRecent: 'most_recent', leastRecent: 'least_recent', unchanged: 'unchanged' };

function isCapacity(value) {
  return Number.isInteger(value) && value >= 1;
}

function createCache() {
  const stacks = new Map();
  const schemas = new Map();
  const capacities = { ...DEFAULT_CACHE_CAPACITIES };
  let evicted = [];
  let reanalyzedIds = new Set();

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
    while (evictableCount() > capacities.stackCapacity) {
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

  function schemaHashesInUse() {
    const inUse = new Set();
    for (const entry of stacks.values()) {
      for (const schema of (entry.data.schemas || new Map()).values()) if (schema.hash) inUse.add(schema.hash);
    }
    return inUse;
  }

  function evictSchemas() {
    const inUse = schemaHashesInUse();
    const unused = [...schemas.values()].filter((schema) => !inUse.has(schema.hash));
    let excess = unused.length - capacities.schemaCapacity;
    for (const schema of unused) {
      if (excess <= 0) break;
      if (schema.notedSinceEviction) continue;
      schemas.delete(schema.hash);
      excess -= 1;
    }
    for (const schema of schemas.values()) schema.notedSinceEviction = false;
  }

  function touchSchema(schema) {
    schemas.delete(schema.hash);
    schemas.set(schema.hash, schema);
  }

  function noteSchema(text, parseText) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const existing = schemas.get(hash);
    if (existing) {
      existing.notedSinceEviction = true;
      touchSchema(existing);
      return hash;
    }
    const parsedObject = parseText(text);
    if (!parsedObject) return null;
    schemas.set(hash, { hash, object: parsedObject, notedSinceEviction: true });
    return hash;
  }

  function schemaObject(hash) {
    const schema = schemas.get(hash);
    if (!schema) return null;
    touchSchema(schema);
    return schema.object;
  }

  function setCapacities(next) {
    for (const key of Object.keys(DEFAULT_CACHE_CAPACITIES)) {
      if (!isCapacity(next[key])) throw new Error(`${key} must be a whole number, 1 or more`);
    }
    Object.assign(capacities, next);
    note(evict());
    evictSchemas();
  }

  function placeStack(entry, recency) {
    const resident = stacks.has(entry.id);
    if (recency === STACK_RECENCY.unchanged && resident) {
      stacks.set(entry.id, entry);
      return;
    }
    stacks.delete(entry.id);
    if (recency === STACK_RECENCY.mostRecent) {
      stacks.set(entry.id, entry);
      return;
    }
    const reordered = [[entry.id, entry], ...stacks];
    stacks.clear();
    for (const [id, held] of reordered) stacks.set(id, held);
  }

  function hold(id, data, flags = {}, recency = STACK_RECENCY.mostRecent) {
    const existing = stacks.get(id);
    const entry = {
      id,
      data,
      pinned: Object.prototype.hasOwnProperty.call(flags, 'pinned') ? flags.pinned : Boolean(existing && existing.pinned),
      onScreen: Object.prototype.hasOwnProperty.call(flags, 'onScreen') ? flags.onScreen : Boolean(existing && existing.onScreen),
    };
    placeStack(entry, recency);
    reanalyzedIds.add(id);
    note(evict());
    evictSchemas();
    return entry;
  }

  function hasRoomForStack() {
    return evictableCount() < capacities.stackCapacity;
  }

  function replaceData(id, data) {
    const entry = stacks.get(id);
    if (!entry) return null;
    entry.data = data;
    reanalyzedIds.add(id);
    evictSchemas();
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
    evictSchemas();
  }

  function drop(id) {
    if (!stacks.delete(id)) return;
    note([id]);
    evictSchemas();
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

  function takeReanalyzed() {
    const residentIds = [...reanalyzedIds].filter((id) => stacks.has(id));
    reanalyzedIds = new Set();
    return residentIds;
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
    setCapacities,
    hold,
    hasRoomForStack,
    replaceData,
    touch,
    setFlags,
    rebalance,
    drop,
    get,
    find,
    entries,
    ids,
    takeEvicted,
    takeReanalyzed,
  };
}

module.exports = { createCache, DEFAULT_CACHE_CAPACITIES, STACK_RECENCY };

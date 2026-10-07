const SCALAR_SHAPE = 'scalar';

function createNodeIds() {
  const idsByKey = new Map();

  function idOf(key) {
    let id = idsByKey.get(key);
    if (id === undefined) {
      id = idsByKey.size + 1;
      idsByKey.set(key, id);
    }
    return id;
  }

  function scalarIds(value) {
    return { id: idOf(`${typeof value}:${String(value)}`), shapeId: idOf(SCALAR_SHAPE) };
  }

  function listIds(items) {
    return {
      id: idOf(`list:${items.map((item) => item.id).join(',')}`),
      shapeId: idOf(`list:${items.map((item) => item.shapeId).join(',')}`),
    };
  }

  function mapIds(entries) {
    const sorted = [...entries].sort((left, right) => (left.key < right.key ? -1 : Number(left.key > right.key)));
    return {
      id: idOf(`map:${sorted.map((entry) => `${JSON.stringify(entry.key)}=${entry.id}`).join(',')}`),
      shapeId: idOf(`map:${sorted.map((entry) => `${JSON.stringify(entry.key)}=${entry.shapeId}`).join(',')}`),
    };
  }

  return {
    scalarIds,
    listIds,
    mapIds,
    size: () => idsByKey.size,
  };
}

module.exports = { createNodeIds };

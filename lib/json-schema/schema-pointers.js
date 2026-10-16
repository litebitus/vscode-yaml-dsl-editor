function pointerSegmentOf(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerSegmentsOf(pointer) {
  return pointer.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function schemaNodePointersOf(root) {
  const pointers = new Map();
  const pending = [[root, '']];
  while (pending.length > 0) {
    const [node, pointer] = pending.pop();
    if (node === null || typeof node !== 'object' || pointers.has(node)) continue;
    pointers.set(node, pointer);
    for (const [key, child] of Object.entries(node)) pending.push([child, `${pointer}/${pointerSegmentOf(key)}`]);
  }
  return pointers;
}

function schemaNodeAt(root, pointer) {
  let node = root;
  for (const segment of pointerSegmentsOf(pointer)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

module.exports = { pointerSegmentsOf, schemaNodePointersOf, schemaNodeAt };

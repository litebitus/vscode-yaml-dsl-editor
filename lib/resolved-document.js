const { Position, resolved } = require('yaml-dsl-spec');

const DOCUMENT_FILE_NAME = 'document';
const UNRESOLVED_TARGET = { kind: 'declaration', position: null };
const WRITTEN_VALUES_ONLY = {
  unknownValueOf: () => null,
  suppliedEntriesOf: () => [],
  unknownMergeFunctionAt: () => null,
};

function scalarNodeOf(value) {
  if (value === null || value === undefined) return { kind: 'null', value: null };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (typeof value === 'number') return { kind: 'number', value: String(value) };
  return { kind: 'string', value: String(value) };
}

function resolvedDocumentOf(value, readers = WRITTEN_VALUES_ONLY, documentPath = []) {
  const unknownValue = readers.unknownValueOf(value);
  if (unknownValue) return unknownValue;
  if (Array.isArray(value)) {
    const items = value.map((item, index) => resolvedDocumentOf(item, readers, [...documentPath, index]));
    return { kind: 'list', value: items };
  }
  if (value === null || typeof value !== 'object') return scalarNodeOf(value);
  const entries = [];
  for (const [key, entryValue] of Object.entries(value)) {
    const suppliedEntries = readers.suppliedEntriesOf(value, key);
    if (suppliedEntries.length > 0) entries.push(...suppliedEntries);
    else entries.push({ key, value: resolvedDocumentOf(entryValue, readers, [...documentPath, key]) });
  }
  const map = { kind: 'map', value: entries };
  const mergeFunction = readers.unknownMergeFunctionAt(documentPath);
  return mergeFunction ? { kind: 'merge_call', value: { function: mergeFunction, map } } : map;
}

function resolvedValueOf(document) {
  let lineCount = 0;
  const nextPosition = () => {
    lineCount += 1;
    return new Position(DOCUMENT_FILE_NAME, lineCount, 1);
  };
  function valueOf(node, position) {
    if (node.kind === 'map') {
      const entries = node.value.map((entry) => {
        const keyPosition = nextPosition();
        return { key: entry.key, keyPosition, value: valueOf(entry.value, keyPosition) };
      });
      return new resolved.Value('map', entries, position);
    }
    if (node.kind === 'list') {
      return new resolved.Value('list', node.value.map((item) => valueOf(item, nextPosition())), position);
    }
    if (node.kind === 'reference') {
      const reference = resolved.reference({ text: node.value.text, target: UNRESOLVED_TARGET });
      return new resolved.Value('reference', reference, position);
    }
    if (node.kind === 'call') {
      return new resolved.Value('call', resolved.call(node.value.function, []), position);
    }
    if (node.kind === 'merge_call') {
      const unknownContent = resolved.reference({ text: node.value.function, target: UNRESOLVED_TARGET });
      const mergeArguments = [
        new resolved.Value('reference', unknownContent, position),
        valueOf(node.value.map, position),
      ];
      return new resolved.Value('call', resolved.call(node.value.function, mergeArguments), position);
    }
    if (node.kind === 'template') {
      return new resolved.Value('template', [resolved.Value.string(node.value.text, position)], position);
    }
    return new resolved.Value(node.kind, node.value, position);
  }
  return valueOf(document, nextPosition());
}

function pointerStepsOf(pointer) {
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map((step) => step.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function entryAt(node, key) {
  const map = node && node.kind === 'merge_call' ? node.value.map : node;
  return map && map.kind === 'map' ? map.value.find((entry) => entry.key === key) || null : null;
}

function documentPathOf(document, pointer) {
  const documentPath = [];
  let node = document;
  for (const step of pointerStepsOf(pointer)) {
    if (node && node.kind === 'list') {
      documentPath.push(Number(step));
      node = node.value[Number(step)];
    } else {
      documentPath.push(step);
      const entry = entryAt(node, step);
      node = entry ? entry.value : null;
    }
  }
  return documentPath;
}

function writtenPathOf(document, documentPath) {
  const writtenPath = [];
  let node = document;
  for (const step of documentPath) {
    if (node && node.kind === 'list') {
      writtenPath.push(step);
      node = node.value[step];
    } else {
      const entry = entryAt(node, step);
      writtenPath.push(entry && entry.sourceKey ? entry.sourceKey : step);
      node = entry ? entry.value : null;
    }
  }
  return writtenPath;
}

module.exports = { resolvedDocumentOf, resolvedValueOf, documentPathOf, writtenPathOf };

const { resolveSymbol } = require('./scope-resolution');
const { commentedBlockLines, keyCommentLines, sourceSpacingOf } = require('./common-layer-edits');

function startsWithPath(documentPath, prefix) {
  return prefix.length <= documentPath.length && prefix.every((step, index) => documentPath[index] === step);
}

function keyColumnOf(text, keyStart) {
  return keyStart - text.lastIndexOf('\n', keyStart - 1) - 1;
}

function referencedFallbackPaths(fallbackDoc, overlayDocs, dsl) {
  const folds = overlayDocs.map((overlayDoc) => ({
    file: overlayDoc.filePath,
    stack: { dsl, common: fallbackDoc.filePath, symbols: [...fallbackDoc.symbols, ...overlayDoc.symbols] },
  }));
  const keptPaths = [];
  let pending = overlayDocs.flatMap((overlayDoc) => overlayDoc.references
    .map((ref) => ({ ref, folds: folds.filter((fold) => fold.file === overlayDoc.filePath) })));
  while (pending.length > 0) {
    const reached = [];
    for (const { ref, folds: refFolds } of pending) {
      for (const fold of refFolds) {
        const target = resolveSymbol(fold.stack, ref, fold.file);
        if (!target || target.builtin || target.file !== fallbackDoc.filePath) continue;
        if (keptPaths.some((keptPath) => startsWithPath(target.documentPath, keptPath))) continue;
        keptPaths.push(target.documentPath);
        reached.push(...fallbackDoc.references
          .filter((fallbackRef) => startsWithPath(fallbackRef.documentPath, target.documentPath))
          .map((fallbackRef) => ({ ref: fallbackRef, folds })));
      }
    }
    pending = reached;
  }
  return keptPaths;
}

function keptEntryLines(fallbackDoc, map, parentPath, keptPaths) {
  const lines = [];
  for (const entry of map.entries) {
    const entryPath = [...parentPath, entry.key];
    const keptWhole = keptPaths.some((keptPath) => startsWithPath(entryPath, keptPath));
    const keptBelow = keptPaths.some((keptPath) => startsWithPath(keptPath, entryPath));
    if (!keptWhole && !keptBelow) continue;
    const column = keyColumnOf(fallbackDoc.text, entry.keyStart);
    const opensMap = !keptWhole && entry.value && entry.value.kind === 'map' && !entry.value.flow;
    const entryLines = opensMap
      ? [
        ...keyCommentLines(fallbackDoc, entry, column),
        `${' '.repeat(column)}${fallbackDoc.text.slice(entry.keyStart, entry.keyEnd)}:`,
        ...keptEntryLines(fallbackDoc, entry.value, entryPath, keptPaths),
      ]
      : commentedBlockLines(fallbackDoc, entry, [], column);
    if (!entryLines) continue;
    if (lines.length > 0) {
      const spacing = sourceSpacingOf([fallbackDoc], entryPath);
      lines.push(...Array(spacing ? spacing.blankLinesAbove : 0).fill(''));
    }
    lines.push(...entryLines);
  }
  return lines;
}

function referencedFallbackText(fallbackDoc, overlayDocs, dsl, seed) {
  const tree = fallbackDoc.tree;
  if (!tree || tree.kind !== 'map' || tree.flow) return seed.text;
  const keptPaths = referencedFallbackPaths(fallbackDoc, overlayDocs, dsl)
    .filter((keptPath) => !seed.keys.includes(keptPath[0]));
  const blockLines = keptEntryLines(fallbackDoc, tree, [], keptPaths);
  if (blockLines.length === 0) return seed.text;
  return `${seed.text}${seed.text ? '\n' : ''}${blockLines.join('\n')}\n`;
}

module.exports = { referencedFallbackPaths, referencedFallbackText };

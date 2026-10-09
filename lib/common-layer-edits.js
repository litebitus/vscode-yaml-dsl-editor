const DEFAULT_INDENT_UNIT = 2;

function lineStartOf(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function afterLineOf(text, offset) {
  const newline = text.indexOf('\n', offset);
  return newline < 0 ? text.length : newline + 1;
}

function columnOf(text, offset) {
  return offset - lineStartOf(text, offset);
}

function indentUnitOf(text) {
  let unit = 0;
  for (const line of text.split('\n')) {
    const indent = line.match(/^ */)[0].length;
    const content = line.trim();
    if (indent > 0 && content !== '' && !content.startsWith('#') && (unit === 0 || indent < unit)) unit = indent;
  }
  return unit || DEFAULT_INDENT_UNIT;
}

function entryOf(node, key) {
  if (!node || node.kind !== 'map') return null;
  return node.entries.find((entry) => entry.key === key) || null;
}

function entryChain(tree, keys) {
  const entries = [];
  let node = tree;
  for (const key of keys) {
    const entry = entryOf(node, key);
    if (!entry) break;
    entries.push(entry);
    node = entry.value;
  }
  return entries;
}

function startsItsLine(text, offset) {
  return text.slice(lineStartOf(text, offset), offset).trim() === '';
}

function deletionOf(doc, keys) {
  const entries = entryChain(doc.tree, keys);
  if (entries.length !== keys.length) return null;
  let index = keys.length - 1;
  while (index > 0 && entries[index - 1].value.entries.length === 1) index -= 1;
  const target = entries[index];
  if (!startsItsLine(doc.text, target.keyStart)) return null;
  const valueEnd = target.value ? target.value.end : target.keyEnd;
  return withBlankLinesMerged(doc.text, {
    start: lineStartOf(doc.text, target.keyStart),
    end: afterLineOf(doc.text, Math.max(valueEnd - 1, target.keyEnd)),
    text: '',
  });
}

function blankLinesBefore(text, offset) {
  let start = offset;
  while (start > 0) {
    const previousStart = lineStartOf(text, start - 1);
    if (text.slice(previousStart, start).trim() !== '') break;
    start = previousStart;
  }
  return start;
}

function blankLinesAfter(text, offset) {
  let end = offset;
  while (end < text.length) {
    const nextEnd = afterLineOf(text, end);
    if (text.slice(end, nextEnd).trim() !== '') break;
    end = nextEnd;
  }
  return end;
}

function withBlankLinesMerged(text, deletion) {
  const blankStart = blankLinesBefore(text, deletion.start);
  const blankEnd = blankLinesAfter(text, deletion.end);
  if (blankEnd === text.length) return { ...deletion, start: blankStart, end: blankEnd };
  if (blankEnd === deletion.end) return deletion;
  if (blankStart < deletion.start || deletion.start === 0) return { ...deletion, end: blankEnd };
  return deletion;
}

function sortedRunLength(entries) {
  let length = 1;
  while (length < entries.length
    && entries[length].key !== null
    && entries[length - 1].key !== null
    && entries[length - 1].key <= entries[length].key) length += 1;
  return length;
}

function placementBySource(entries, newKey, sourceKeys) {
  const sourceIndex = sourceKeys.indexOf(newKey);
  if (sourceIndex < 0) return null;
  for (const key of sourceKeys.slice(sourceIndex + 1)) {
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry) return { before: entry };
  }
  for (const key of sourceKeys.slice(0, sourceIndex).reverse()) {
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry) return { after: entry };
  }
  return null;
}

function significanceRankOf(key, keySortOrder) {
  const firstIndex = keySortOrder.firstKeys.indexOf(key);
  if (firstIndex >= 0) return firstIndex;
  const lastIndex = keySortOrder.lastKeys.indexOf(key);
  if (lastIndex >= 0) return keySortOrder.firstKeys.length + 1 + lastIndex;
  return keySortOrder.firstKeys.length;
}

function placementIn(parentMap, newKey, keySortOrder, sourceKeyLists) {
  const { entries } = parentMap;
  if (keySortOrder.order === 'alphabetical') {
    const run = entries.slice(0, sortedRunLength(entries));
    const following = run.find((entry) => entry.key !== null && entry.key > newKey);
    return following ? { before: following } : { after: run[run.length - 1] };
  }
  const rankOf = (key) => significanceRankOf(key, keySortOrder);
  const newKeyRank = rankOf(newKey);
  const otherKeysRank = keySortOrder.firstKeys.length;
  if (newKeyRank === otherKeysRank) {
    const otherEntries = entries.filter((entry) => rankOf(entry.key) === otherKeysRank);
    for (const sourceKeys of sourceKeyLists) {
      const otherSourceKeys = sourceKeys.filter((key) => rankOf(key) === otherKeysRank);
      const placement = placementBySource(otherEntries, newKey, otherSourceKeys);
      if (placement) return placement;
    }
  }
  const rankedAfter = entries.find((entry) => rankOf(entry.key) > newKeyRank);
  return rankedAfter ? { before: rankedAfter } : { after: entries[entries.length - 1] };
}

function lineCountBetween(text, start, end) {
  return text.slice(start, end).split('\n').length - 1;
}

function entryEndOf(text, entry) {
  return afterLineOf(text, Math.max((entry.value ? entry.value.end : entry.keyEnd) - 1, entry.keyEnd));
}

const NO_BLANK_LINES = { blankLinesAbove: 0, blankLinesBelow: 0 };
const BLOCK_DEFAULT_SPACING = { blankLinesAbove: 1, blankLinesBelow: 1 };

function sourceSpacingOf(sourceDocs, keys) {
  for (const doc of sourceDocs) {
    const entries = entryChain(doc.tree, keys);
    if (entries.length !== keys.length) continue;
    const entry = entries[entries.length - 1];
    const keyLineStart = lineStartOf(doc.text, entry.keyStart);
    const blockEnd = entryEndOf(doc.text, entry);
    const blanksEnd = blankLinesAfter(doc.text, blockEnd);
    return {
      blankLinesAbove: lineCountBetween(doc.text, blankLinesBefore(doc.text, keyLineStart), keyLineStart),
      blankLinesBelow: blanksEnd === doc.text.length ? 0 : lineCountBetween(doc.text, blockEnd, blanksEnd),
    };
  }
  return null;
}

function defaultSpacingOf(body) {
  return body.split('\n').length - 1 > 1 ? BLOCK_DEFAULT_SPACING : NO_BLANK_LINES;
}

function spacedInsertionEdit(offset, prefix, body, sourceSpacing) {
  return {
    start: offset,
    end: offset,
    text: `${prefix}${body}`,
    prefix,
    body,
    spacing: sourceSpacing || defaultSpacingOf(body),
  };
}

function orderedEdits(edits) {
  return edits
    .map((edit, order) => ({ edit, order }))
    .sort((left, right) => left.edit.start - right.edit.start
      || Number(left.edit.start !== left.edit.end) - Number(right.edit.start !== right.edit.end)
      || left.order - right.order)
    .map(({ edit }) => edit);
}

function bodySpanAfterEdits(text, ordered, target) {
  let finalText = '';
  let cursor = 0;
  let bodyStart = 0;
  for (const edit of ordered) {
    finalText += text.slice(cursor, Math.max(cursor, edit.start));
    if (edit === target) bodyStart = finalText.length + edit.prefix.length;
    finalText += edit.text;
    cursor = Math.max(cursor, edit.end);
  }
  finalText += text.slice(cursor);
  return { finalText, bodyStart, bodyEnd: bodyStart + target.body.length };
}

function blankLinesNeeded(finalText, bodyStart, bodyEnd, spacing) {
  const blanksStart = blankLinesBefore(finalText, bodyStart);
  const blanksEnd = blankLinesAfter(finalText, bodyEnd);
  const contentAbove = finalText.slice(0, blanksStart).trim() !== '';
  const contentBelow = blanksEnd < finalText.length;
  const presentAbove = lineCountBetween(finalText, blanksStart, bodyStart);
  const presentBelow = lineCountBetween(finalText, bodyEnd, blanksEnd);
  return {
    above: contentAbove ? Math.max(0, spacing.blankLinesAbove - presentAbove) : 0,
    below: contentBelow ? Math.max(0, spacing.blankLinesBelow - presentBelow) : 0,
  };
}

function insertionsMovedOutOfDeletions(edits) {
  const deletions = edits.filter((edit) => edit.start < edit.end && edit.text === '');
  return edits.map((edit) => {
    if (edit.start !== edit.end) return { ...edit };
    const covering = deletions.find((deletion) => deletion.start < edit.start && edit.start < deletion.end);
    return covering ? { ...edit, start: covering.start, end: covering.start } : { ...edit };
  });
}

function spacedEdits(text, edits) {
  const ordered = orderedEdits(insertionsMovedOutOfDeletions(edits));
  for (const edit of ordered) {
    if (!edit.spacing) continue;
    const { finalText, bodyStart, bodyEnd } = bodySpanAfterEdits(text, ordered, edit);
    const { above, below } = blankLinesNeeded(finalText, bodyStart, bodyEnd, edit.spacing);
    edit.text = `${edit.prefix}${'\n'.repeat(above)}${edit.body}${'\n'.repeat(below)}`;
  }
  return ordered;
}

function offsetOf(text, placement) {
  if (placement.before) return lineStartOf(text, placement.before.keyStart);
  return entryEndOf(text, placement.after);
}

function insertionPoint(doc, keys, placementFor) {
  const entries = entryChain(doc.tree, keys);
  const depth = entries.length;
  const parent = depth === 0 ? doc.tree : entries[depth - 1].value;
  const text = doc.text;
  if (depth === 0 && !parent) {
    const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
    return { depth, offset: text.length, prefix, indent: 0, spacing: null };
  }
  if (!parent || parent.kind !== 'map' || parent.flow || parent.entries.length === 0) return null;
  if (depth === keys.length) return { depth };
  const placement = placementFor(parent, keys.slice(0, depth), keys[depth]);
  if (!placement) return null;
  const anchor = placement.before || placement.after;
  if (!startsItsLine(text, anchor.keyStart)) return null;
  const offset = offsetOf(text, placement);
  const prefix = offset === text.length && !text.endsWith('\n') ? '\n' : '';
  return { depth, offset, prefix, indent: columnOf(text, anchor.keyStart), spacing: placement.spacing };
}

function insertionUnder(doc, keys, keyTexts, finalLines, placementFor) {
  const point = insertionPoint(doc, keys, placementFor);
  if (!point || point.depth === keys.length) return null;
  const unit = indentUnitOf(doc.text);
  const lines = [];
  let indent = point.indent;
  for (let index = point.depth; index < keys.length - 1; index += 1) {
    lines.push(`${' '.repeat(indent)}${keyTexts[index]}:`);
    indent += unit;
  }
  const final = finalLines(indent, unit);
  if (final === null) return null;
  const body = `${[...lines, ...final].join('\n')}\n`;
  return spacedInsertionEdit(point.offset, point.prefix, body, point.spacing);
}

function entryReplacement(doc, keys, finalLines) {
  const entries = entryChain(doc.tree, keys);
  if (entries.length !== keys.length) return null;
  const entry = entries[entries.length - 1];
  if (!startsItsLine(doc.text, entry.keyStart)) return null;
  const lines = finalLines(columnOf(doc.text, entry.keyStart));
  if (lines === null) return null;
  return {
    start: lineStartOf(doc.text, entry.keyStart),
    end: entryEndOf(doc.text, entry),
    text: `${lines.join('\n')}\n`,
  };
}

function declarationLine(declared, indent) {
  return `${' '.repeat(indent)}${declared.name}: ${declared.valueText}`;
}

function localsInsertion(doc, localsKeys, keyTexts, declarations, placementFor) {
  if (declarations.length === 0) return [];
  const sorted = [...declarations].sort((left, right) => (
    left.name < right.name ? -1 : Number(left.name > right.name)
  ));
  const entries = entryChain(doc.tree, localsKeys);
  if (entries.length < localsKeys.length) {
    const opened = insertionUnder(doc, localsKeys, keyTexts, (indent, unit) => [
      `${' '.repeat(indent)}${keyTexts[localsKeys.length - 1]}:`,
      ...sorted.map((declared) => declarationLine(declared, indent + unit)),
    ], placementFor);
    return opened ? [opened] : null;
  }
  const localsMap = entries[entries.length - 1].value;
  if (!localsMap || localsMap.kind !== 'map' || localsMap.flow || localsMap.entries.length === 0) return null;
  const edits = [];
  for (const declared of sorted) {
    const placement = placementFor(localsMap, localsKeys, declared.name);
    if (!placement || !startsItsLine(doc.text, (placement.before || placement.after).keyStart)) return null;
    const offset = offsetOf(doc.text, placement);
    const prefix = offset === doc.text.length && !doc.text.endsWith('\n') ? '\n' : '';
    const indent = columnOf(doc.text, localsMap.entries[0].keyStart);
    const body = `${declarationLine(declared, indent)}\n`;
    edits.push(spacedInsertionEdit(offset, prefix, body, placement.spacing));
  }
  return edits;
}

function blockLines(sourceDoc, entry, replacements, indent) {
  const { text } = sourceDoc;
  const start = entry.keyStart;
  const end = entry.value ? entry.value.end : entry.keyEnd;
  let slice = text.slice(start, end);
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    slice = slice.slice(0, replacement.start - start) + replacement.text + slice.slice(replacement.end - start);
  }
  const sourceColumn = columnOf(text, start);
  const lines = slice.replace(/\n+$/, '').split('\n');
  const shifted = [`${' '.repeat(indent)}${lines[0]}`];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') {
      shifted.push('');
      continue;
    }
    if (line.match(/^ */)[0].length < sourceColumn) return null;
    shifted.push(`${' '.repeat(indent)}${line.slice(sourceColumn)}`);
  }
  return shifted;
}

function normalizedEdits(text, edits) {
  const merged = [];
  for (const edit of spacedEdits(text, edits)) {
    const previous = merged[merged.length - 1];
    if (previous && edit.start < previous.end) return null;
    if (previous && previous.end === edit.start && (previous.start === previous.end || edit.start === edit.end)) {
      merged[merged.length - 1] = { start: previous.start, end: edit.end, text: previous.text + edit.text };
      continue;
    }
    merged.push({ start: edit.start, end: edit.end, text: edit.text });
  }
  return merged;
}

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

module.exports = {
  entryChain,
  deletionOf,
  entryReplacement,
  insertionUnder,
  localsInsertion,
  placementIn,
  sourceSpacingOf,
  NO_BLANK_LINES,
  blockLines,
  normalizedEdits,
  applyEdits,
};

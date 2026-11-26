const VALUE_QUOTES = ['"', "'"];

function startInsideQuote(line, start) {
  return VALUE_QUOTES.includes(line[start]) ? start + 1 : start;
}

function openingQuoteBefore(line, valueStart) {
  const quote = line[valueStart - 1];
  return VALUE_QUOTES.includes(quote) ? quote : null;
}

function keyLayoutOf(line) {
  const itemMarker = line.match(/^\s*-\s+/);
  const itemStart = itemMarker ? itemMarker[0].length : line.match(/^\s*/)[0].length;
  const separator = line.slice(itemStart).search(/:(?:\s|$)/);
  return { itemMarker, itemStart, separator };
}

function valueStarts(line) {
  const { itemMarker, itemStart, separator } = keyLayoutOf(line);
  const starts = [];
  if (separator >= 0) {
    const afterKey = itemStart + separator + 1;
    starts.push(afterKey + line.slice(afterKey).match(/^\s*/)[0].length);
  } else if (itemMarker) {
    starts.push(itemStart);
  }
  const flowItem = /[[,]\s*/g;
  let match = flowItem.exec(line);
  while (match) {
    starts.push(match.index + match[0].length);
    match = flowItem.exec(line);
  }
  return starts.map((start) => startInsideQuote(line, start));
}

function keySpanOf(line) {
  const { itemStart, separator } = keyLayoutOf(line);
  if (itemStart >= line.length) return null;
  const start = startInsideQuote(line, itemStart);
  if (separator < 0) return { start, end: null };
  const end = itemStart + separator;
  return { start, end: start > itemStart && line[end - 1] === line[itemStart] ? end - 1 : end };
}

module.exports = { valueStarts, keySpanOf, openingQuoteBefore };

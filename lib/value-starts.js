const VALUE_QUOTES = ['"', "'"];

function startInsideQuote(line, start) {
  return VALUE_QUOTES.includes(line[start]) ? start + 1 : start;
}

function openingQuoteBefore(line, valueStart) {
  const quote = line[valueStart - 1];
  return VALUE_QUOTES.includes(quote) ? quote : null;
}

function valueStarts(line) {
  const itemMarker = line.match(/^\s*-\s+/);
  const itemStart = itemMarker ? itemMarker[0].length : line.match(/^\s*/)[0].length;
  const separator = line.slice(itemStart).search(/:(?:\s|$)/);
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

module.exports = { valueStarts, openingQuoteBefore };

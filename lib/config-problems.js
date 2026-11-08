const { zeroRange } = require('./range');
const { withSchemaNote } = require('./problem-kinds');

const QUOTES = new Set(['"', "'"]);
const COLLECTION_CLOSERS = { '[': ']', '{': '}' };
const FLOW_ENDS = new Set([',', ']', '}']);

/** The UTF-16 offset in `line` of a 1-based column counted in characters. */
function characterOffsetOf(line, column) {
  return Array.from(line).slice(0, column - 1).join('').length;
}

function quotedEndOf(line, start) {
  const quote = line[start];
  for (let index = start + 1; index < line.length; index += 1) {
    if (quote === '"' && line[index] === '\\') index += 1;
    else if (quote === "'" && line[index] === "'" && line[index + 1] === "'") index += 1;
    else if (line[index] === quote) return index + 1;
  }
  return line.length;
}

function collectionEndOf(line, start) {
  const opener = line[start];
  let depth = 0;
  for (let index = start; index < line.length; index += 1) {
    if (QUOTES.has(line[index])) {
      index = quotedEndOf(line, index) - 1;
    } else if (line[index] === opener) {
      depth += 1;
    } else if (line[index] === COLLECTION_CLOSERS[opener]) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return line.length;
}

function plainEndOf(line, start) {
  let end = start;
  while (end < line.length) {
    const character = line[end];
    const indicator = character === ':' && (end + 1 === line.length || /\s/.test(line[end + 1]));
    const comment = character === '#' && end > start && /\s/.test(line[end - 1]);
    if (FLOW_ENDS.has(character) || indicator || comment) break;
    end += 1;
  }
  while (end > start && /\s/.test(line[end - 1])) end -= 1;
  return end;
}

/** Where the scalar, key or flow collection starting at `start` of `line` ends. */
function tokenEndOf(line, start) {
  if (QUOTES.has(line[start])) return quotedEndOf(line, start);
  if (COLLECTION_CLOSERS[line[start]]) return collectionEndOf(line, start);
  return plainEndOf(line, start);
}

/** A diagnostic's text as a hover shows it: its message, then its label and help. */
function problemMessageOf(diagnostic) {
  const notes = diagnostic.notes || {};
  const explained = [notes.label, notes.help].filter((note) => note !== null && note !== undefined);
  return explained.length === 0 ? diagnostic.message : `${diagnostic.message}\n\n${explained.join('; ')}`;
}

/**
 * A problem the standard's reader found in a `yaml-dsl.yml`, at the text it is
 * about: from its position to the end of the token written there.
 */
function configProblemOf(text, diagnostic) {
  const message = problemMessageOf(diagnostic);
  const schemaNote = (diagnostic.notes || {}).schema;
  if (!diagnostic.position) return withSchemaNote({ range: zeroRange(), message }, schemaNote);
  const lineIndex = diagnostic.position.line - 1;
  const line = String(text).split('\n')[lineIndex] || '';
  const start = characterOffsetOf(line.replace(/\r$/, ''), diagnostic.position.column);
  const end = tokenEndOf(line.replace(/\r$/, ''), start);
  return withSchemaNote({
    range: { start: { line: lineIndex, character: start }, end: { line: lineIndex, character: end } },
    message,
  }, schemaNote);
}

module.exports = { configProblemOf };

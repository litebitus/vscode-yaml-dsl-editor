const { templateReader, codeSpan } = require('yaml-dsl-spec');
const { contains, rangeBetween } = require('./range');
const { configProblemOf } = require('./config-problems');

const VARIABLE_SEPARATOR = ', ';

function lineStartsOf(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** The UTF-16 offset in `text` of a standard position: a 1-based line and a 1-based column in characters. */
function offsetOfPosition(text, lineStarts, position) {
  const lineStart = lineStarts[position.line - 1] || 0;
  const lineEnd = text.indexOf('\n', lineStart);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  return lineStart + Array.from(line).slice(0, position.column - 1).join('').length;
}

/** The template a file of a template language holds, as the standard's reader reads it; none for a document. */
function templateReadingOf(dsl, filePath, text) {
  if (!dsl || !dsl.template) return null;
  return templateReader.readTemplate(filePath, String(text), dsl.template.definition);
}

function spannedActionsOf(reading, text) {
  const lineStarts = lineStartsOf(text);
  return reading.actions.map((action) => {
    const start = offsetOfPosition(text, lineStarts, action.position);
    return { action, start, end: start + action.text.length };
  });
}

/** The ranges of a template's actions that stand for values, each known only when the template is rendered. */
function renderedValueRangesOf(reading, text) {
  if (!reading) return [];
  return spannedActionsOf(reading, text)
    .filter(({ action }) => !action.directive)
    .map(({ start, end }) => rangeBetween(text, start, end));
}

function rangesMeet(range, other) {
  const before = (left, right) => left.line < right.line || (left.line === right.line && left.character < right.character);
  return before(range.start, other.end) && before(other.start, range.end);
}

/** Whether `range` holds any of `renderedRanges`, so what it is about is known only when the template is rendered. */
function holdsRenderedValue(range, renderedRanges) {
  return Boolean(range) && renderedRanges.some((rendered) => rangesMeet(range, rendered));
}

/** The template reader's problems, each at the text it is about. */
function templateProblemsOf(reading, text) {
  return reading ? reading.problems.map((diagnostic) => configProblemOf(text, diagnostic)) : [];
}

function branchSpansOf(blocks, spans = []) {
  for (const block of blocks) {
    if (block.branches) {
      block.branches.forEach((branch, index) => {
        const next = block.branches[index + 1];
        const endingAction = next ? next.opening : block.closing;
        spans.push({
          conditional: block,
          index,
          firstLine: branch.opening.position.line,
          lastLine: endingAction ? endingAction.position.line : Number.POSITIVE_INFINITY,
        });
        branchSpansOf(branch.blocks, spans);
      });
    } else {
      branchSpansOf(block.blocks, spans);
    }
  }
  return spans;
}

/**
 * The duplicate keys of a template, each without the other lines that sit in
 * another branch of a conditional holding it, and none whose every other line does.
 */
function duplicateKeysOutsideBranches(duplicateKeys, reading) {
  if (!reading) return duplicateKeys;
  const spans = branchSpansOf(reading.blocks);
  const branchesOf = (line) => spans.filter((span) => line >= span.firstLine && line <= span.lastLine);
  const acrossBranches = (line, otherLine) => branchesOf(line).some((span) => branchesOf(otherLine)
    .some((other) => other.conditional === span.conditional && other.index !== span.index));
  return duplicateKeys
    .map((duplicate) => ({
      ...duplicate,
      otherLines: duplicate.otherLines
        .filter((otherLine) => !acrossBranches(duplicate.range.start.line + 1, otherLine + 1)),
    }))
    .filter((duplicate) => duplicate.otherLines.length > 0);
}

function directiveWordLengthOf(body, definition) {
  const loopStart = new RegExp(definition.loop.start.source, 'du').exec(body);
  if (loopStart && loopStart.index === 0) {
    return body.slice(0, loopStart.indices.groups.variables[0]).replace(/ +$/u, '').length;
  }
  const words = [
    definition.conditional.if,
    definition.conditional.else_if,
    definition.conditional.else,
    definition.conditional.end,
    definition.loop.end,
  ];
  return words
    .filter((word) => body === word || body.startsWith(`${word} `))
    .reduce((longest, word) => Math.max(longest, word.length), 0);
}

function bindingSpansOf(action, start, definition) {
  const { left } = definition.delimiters;
  const rawBody = action.text.slice(left.length, action.text.length - definition.delimiters.right.length);
  const bodyStart = start + left.length + (rawBody.length - rawBody.replace(/^ +/u, '').length);
  const loopStart = new RegExp(definition.loop.start.source, 'du').exec(rawBody.trim());
  if (!loopStart || loopStart.index !== 0) return [];
  const spans = [];
  let cursor = bodyStart + loopStart.indices.groups.variables[0];
  for (const name of loopStart.groups.variables.split(VARIABLE_SEPARATOR)) {
    spans.push({ start: cursor, end: cursor + name.length, name });
    cursor += name.length + VARIABLE_SEPARATOR.length;
  }
  return spans;
}

/** Each loop variable of a template with its span, a binding in its loop's opening action included, and the loop it is of. */
function loopVariableSpansOf(reading, text, definition) {
  if (!reading) return [];
  const lineStarts = lineStartsOf(text);
  const spans = reading.variables.map((variable) => {
    const start = offsetOfPosition(text, lineStarts, variable.position);
    return { start, end: start + variable.name.length, name: variable.name, loop: variable.loop };
  });
  const loopsOf = (blocks) => blocks.flatMap((block) => (block.branches
    ? block.branches.flatMap((branch) => loopsOf(branch.blocks))
    : [block, ...loopsOf(block.blocks)]));
  for (const loop of loopsOf(reading.blocks)) {
    const start = offsetOfPosition(text, lineStarts, loop.opening.position);
    for (const binding of bindingSpansOf(loop.opening, start, definition)) spans.push({ ...binding, loop });
  }
  return spans;
}

/** Each template variable of a template with its span. */
function templateVariableSpansOf(reading, text) {
  if (!reading) return [];
  const lineStarts = lineStartsOf(text);
  return reading.templateVariables.map((variable) => {
    const start = offsetOfPosition(text, lineStarts, variable.position);
    return { start, end: start + variable.name.length, name: variable.name };
  });
}

/** The semantic tokens a template's actions add: delimiters, directive words, loop variables and template variables. */
function templateTokensOf(reading, text, definition) {
  if (!reading) return [];
  const { left, right } = definition.delimiters;
  const tokens = [];
  for (const { action, start, end } of spannedActionsOf(reading, text)) {
    tokens.push({ start, end: start + left.length, type: 'operator' });
    if (action.directive) {
      const rawBody = action.text.slice(left.length, action.text.length - right.length);
      const bodyStart = start + left.length + (rawBody.length - rawBody.replace(/^ +/u, '').length);
      const wordLength = directiveWordLengthOf(rawBody.trim(), definition);
      if (wordLength > 0) tokens.push({ start: bodyStart, end: bodyStart + wordLength, type: 'keyword' });
    }
    tokens.push({ start: end - right.length, end, type: 'operator' });
  }
  for (const variable of loopVariableSpansOf(reading, text, definition)) {
    tokens.push({ start: variable.start, end: variable.end, type: 'variable' });
  }
  for (const variable of templateVariableSpansOf(reading, text)) {
    tokens.push({ start: variable.start, end: variable.end, type: 'parameter' });
  }
  return tokens;
}

/** The loop variable at `position` of a template, with its range and the range of its loop's opening action. */
function loopVariableAt(reading, text, definition, position) {
  if (!reading) return null;
  const lineStarts = lineStartsOf(text);
  for (const variable of loopVariableSpansOf(reading, text, definition)) {
    const range = rangeBetween(text, variable.start, variable.end);
    if (!contains(range, position) || !variable.loop) continue;
    const openingStart = offsetOfPosition(text, lineStarts, variable.loop.opening.position);
    return {
      name: variable.name,
      range,
      opening: variable.loop.opening,
      openingRange: rangeBetween(text, openingStart, openingStart + variable.loop.opening.text.length),
    };
  }
  return null;
}

/** A loop variable's hover text: the loop that binds it. */
function loopVariableHoverTextOf(found) {
  return `${codeSpan(found.name)}: a loop variable of ${codeSpan(found.opening.text)}`;
}

/** The template variable at `position` of a template, with its range. */
function templateVariableAt(reading, text, position) {
  for (const variable of templateVariableSpansOf(reading, text)) {
    const range = rangeBetween(text, variable.start, variable.end);
    if (contains(range, position)) return { name: variable.name, range };
  }
  return null;
}

/** A template variable's hover text. */
function templateVariableHoverTextOf(found) {
  return `template variable ${codeSpan(found.name)}, a value the template is rendered with`;
}

/** Whether `text` holds an action of a template language, so its value is known only when the template is rendered. */
function holdsTemplateAction(text, template) {
  if (!template) return false;
  const { left, right } = template.definition.delimiters;
  const leftAt = text.indexOf(left);
  return leftAt >= 0 && text.indexOf(right, leftAt + left.length) >= 0;
}

function templateTextOf(node, text) {
  const written = text.slice(node.start, node.end);
  const quote = written[0];
  const quoted = (quote === '"' || quote === "'") && written.length > 1 && written.endsWith(quote);
  return quoted ? written.slice(1, -1) : written;
}

/** A template's value, each scalar holding an action read as its template text, as a document's value is read from its tree. */
function templateValueOf(node, text, renderedRanges) {
  if (!node) return null;
  if (node.kind === 'map') {
    return Object.fromEntries(node.entries
      .filter((entry) => entry.key !== null)
      .map((entry) => [entry.key, templateValueOf(entry.value, text, renderedRanges)]));
  }
  if (node.kind === 'seq') return node.items.map((item) => templateValueOf(item, text, renderedRanges));
  return holdsRenderedValue(node.range, renderedRanges) ? templateTextOf(node, text) : node.value;
}

module.exports = {
  templateReadingOf,
  templateValueOf,
  holdsTemplateAction,
  renderedValueRangesOf,
  holdsRenderedValue,
  templateProblemsOf,
  duplicateKeysOutsideBranches,
  templateTokensOf,
  loopVariableAt,
  loopVariableHoverTextOf,
  templateVariableAt,
  templateVariableHoverTextOf,
};

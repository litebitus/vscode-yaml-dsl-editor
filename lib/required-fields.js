const { schemaParserFor } = require('./json-schema-core');
const { REQUIREMENT_MARKERS } = require('./schema-checks');
const { keySortOrderFor, sortedKeys } = require('./key-sort-orders');
const {
  VALUE_KINDS,
  placeOfLine,
  valueKindOf,
  offeredValuesOf,
  fieldRequirementOf,
  defaultValueTextAt,
} = require('./schema-completion');

const EMPTY_VALUE_KEY_LINE = /^(\s*)((?:-\s+)?)([^\s:#'"{}[\],&*!|>%@`-][^:#]*?):\s*(?:#.*)?$/;

function indentWidthOf(line) {
  return line.match(/^\s*/)[0].length;
}

function holdsLinesBelow(lines, keyLine, keyColumn) {
  for (const line of lines.slice(keyLine + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return indentWidthOf(line) > keyColumn;
  }
  return false;
}

function requiredFieldsToFill({ text, keyLine, schema, dsl, heldKeysAt }) {
  const parser = schemaParserFor(schema);
  if (!parser) return null;
  const lines = String(text || '').split('\n');
  const keyMatch = (lines[keyLine] || '').match(EMPTY_VALUE_KEY_LINE);
  if (!keyMatch) return null;
  const [, indent, itemMarker, writtenKey] = keyMatch;
  const keyColumn = indent.length + itemMarker.length;
  if (holdsLinesBelow(lines, keyLine, keyColumn)) return null;
  const place = placeOfLine(text, keyLine, `${indent}${itemMarker}`);
  if (!place) return null;
  const mapPath = [...place.path, writtenKey.trimEnd()];
  if (valueKindOf(parser.valueFormsAt(mapPath)) !== VALUE_KINDS.map) return null;
  const node = parser.nodeAt(mapPath);
  const requiredKeys = new Set(parser.requiredKeysOf(node));
  const heldKeys = new Set(heldKeysAt(mapPath));
  const fillKeys = Object.entries(parser.fieldsOf(node))
    .filter(([key, field]) => fieldRequirementOf(field, key, requiredKeys) === REQUIREMENT_MARKERS.required)
    .map(([key]) => key)
    .filter((key) => !heldKeys.has(key));
  if (fillKeys.length === 0) return null;
  const fields = sortedKeys(fillKeys, keySortOrderFor(dsl, mapPath)).map((key) => {
    const forms = parser.valueFormsAt([...mapPath, key]);
    const valueKind = valueKindOf(forms);
    return {
      key,
      valueKind,
      values: valueKind === VALUE_KINDS.scalar ? offeredValuesOf(forms) : [],
      defaultValue: valueKind === VALUE_KINDS.scalar ? defaultValueTextAt(parser, [...mapPath, key]) : null,
    };
  });
  return { keyColumn, fields };
}

module.exports = { requiredFieldsToFill };

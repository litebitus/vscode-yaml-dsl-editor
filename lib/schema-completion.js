const YAML = require('yaml');
const { schemaParserForDocument } = require('./json-schema');
const { REQUIREMENT_MARKERS, requirementMarkerOf, descriptionTextOf } = require('./schema-checks');
const { snippetTextOf } = require('./snippet-text');
const { keyOfTag } = require('./tag-keys');

const PROBE_KEY = 'yaml_dsl_editor_completion_probe';
const CHILD_INDENT = '  ';
const KEY_POSITION = /^(\s*)((?:-\s+)?)([^\s:#'"{}[\],&*!|>%@`-][^\s:#'"{}[\],]*|)$/;
const VALUE_POSITION = /^(\s*)((?:-\s+)?)([^\s:#'"{}[\],&*!|>%@`-][^:#]*?):\s+([^\s#'"{}[\],]*)$/;
const VALUE_KINDS = { map: 'map', list: 'list', scalar: 'scalar' };

function probedPlace(node, outerPath, tagKeys) {
  const tagKey = node ? keyOfTag(tagKeys, node.tag) : null;
  const path = tagKey === null ? outerPath : [...outerPath, tagKey];
  if (YAML.isMap(node)) {
    const keys = node.items.map((pair) => (pair.key && pair.key.value != null ? String(pair.key.value) : null));
    if (keys.includes(PROBE_KEY)) {
      return { path, heldKeys: new Set(keys.filter((key) => key !== null && key !== PROBE_KEY)) };
    }
    for (const [index, pair] of node.items.entries()) {
      const found = probedPlace(pair.value, [...path, keys[index]], tagKeys);
      if (found) return found;
    }
  }
  if (YAML.isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      const found = probedPlace(item, [...path, index], tagKeys);
      if (found) return found;
    }
  }
  return null;
}

function placeOfLine(text, lineIndex, linePrefix, tagKeys = [], rootPath = []) {
  const lines = String(text || '').split('\n');
  lines[lineIndex] = `${linePrefix}${PROBE_KEY}: 0`;
  return probedPlace(YAML.parseDocument(lines.join('\n')).contents, rootPath, tagKeys);
}

function typedValueKeyOf(beforeCursor) {
  const valueMatch = beforeCursor.match(VALUE_POSITION);
  return valueMatch ? valueMatch[3].trimEnd() : null;
}

function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return Number.isInteger(value) ? 'integer' : typeof value;
}

function typesOfForm(form) {
  if (form.type !== undefined) return [].concat(form.type);
  if (form.const !== undefined) return [jsonTypeOf(form.const)];
  if (Array.isArray(form.enum)) return [...new Set(form.enum.map(jsonTypeOf))];
  if (form.properties || form.patternProperties || form.additionalProperties !== undefined) return ['object'];
  if (form.items !== undefined || form.prefixItems !== undefined) return ['array'];
  return [];
}

function valueKindOf(forms) {
  const formTypes = forms.map(typesOfForm);
  if (formTypes.length === 0 || formTypes.some((types) => types.length === 0)) return VALUE_KINDS.scalar;
  const allTypes = new Set(formTypes.flat());
  if (allTypes.size === 1 && allTypes.has('object')) return VALUE_KINDS.map;
  if (allTypes.size === 1 && allTypes.has('array')) return VALUE_KINDS.list;
  return VALUE_KINDS.scalar;
}

function isScalarValue(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function offeredValuesOf(forms) {
  const values = [];
  for (const form of forms) {
    if (Array.isArray(form.enum)) values.push(...form.enum.filter(isScalarValue));
    else if (form.const !== undefined && isScalarValue(form.const)) values.push(form.const);
    else if (typesOfForm(form).includes('boolean')) values.push(true, false);
  }
  const texts = values.map((value) => YAML.stringify(value).trimEnd());
  return [...new Set(texts)];
}

function defaultValueTextAt(parser, fieldPath) {
  const stated = parser.defaultValueOf(parser.nodeAt(fieldPath));
  if (!stated || !isScalarValue(stated.value)) return null;
  return YAML.stringify(stated.value).trimEnd();
}

function rangeOnLine(line, start, end) {
  return { start: { line, character: start }, end: { line, character: end } };
}

function fieldRequirementOf(field, key, requiredKeys) {
  return requirementMarkerOf(field)
    || (requiredKeys.has(key) ? REQUIREMENT_MARKERS.required : REQUIREMENT_MARKERS.optional);
}

function fieldCompletions(parser, place, range, keyColumn) {
  const node = parser.nodeAt(place.path);
  if (!node || node === true) return [];
  const requiredKeys = new Set(parser.requiredKeysAt(place.path));
  return Object.entries(parser.fieldsAt(place.path))
    .map(([key, field]) => {
      const fieldPath = [...place.path, key];
      const marker = fieldRequirementOf(field, key, requiredKeys);
      const forms = parser.valueFormsAt(fieldPath);
      const valueKind = valueKindOf(forms);
      const childIndent = `${' '.repeat(keyColumn)}${CHILD_INDENT}`;
      const description = descriptionTextOf(field) || '';
      const defaultValueText = valueKind === VALUE_KINDS.scalar ? defaultValueTextAt(parser, fieldPath) : null;
      let insertText = valueKind === VALUE_KINDS.scalar ? `${key}: ` : `${key}:\n${childIndent}`;
      if (defaultValueText !== null) insertText = `${snippetTextOf(key)}: \${1:${snippetTextOf(defaultValueText)}}`;
      return {
        label: key,
        labelDescription: description ? `${marker} ${description}` : marker,
        kind: 'field',
        detail: marker,
        documentation: description,
        deprecated: parser.fieldDeprecated(fieldPath),
        insertText,
        insertsSnippet: defaultValueText !== null,
        suggestsValues: valueKind === VALUE_KINDS.scalar
          && defaultValueText === null
          && offeredValuesOf(forms).length > 0,
        range,
      };
    });
}

function valueCompletions(parser, valuePath, range) {
  return offeredValuesOf(parser.valueFormsAt(valuePath)).map((valueText) => ({
    label: valueText,
    labelDescription: '',
    kind: 'enumValue',
    detail: '',
    documentation: '',
    deprecated: false,
    insertText: valueText,
    insertsSnippet: false,
    suggestsValues: false,
    range,
  }));
}

function schemaCompletionsAt(text, position, schema, { tagKeys = [], documentValue, rootPath = [] } = {}) {
  const parser = schemaParserForDocument(schema, documentValue);
  const lines = String(text || '').split('\n');
  if (!parser || position.line >= lines.length) return [];
  const lineText = lines[position.line];
  const beforeCursor = lineText.slice(0, position.character);
  const valueMatch = beforeCursor.match(VALUE_POSITION);
  if (valueMatch) {
    const [, indent, itemMarker, key, typedValue] = valueMatch;
    const place = placeOfLine(text, position.line, `${indent}${itemMarker}`, tagKeys, rootPath);
    if (!place) return [];
    const range = rangeOnLine(position.line, position.character - typedValue.length, position.character);
    return valueCompletions(parser, [...place.path, key.trimEnd()], range);
  }
  const keyMatch = beforeCursor.match(KEY_POSITION);
  if (!keyMatch) return [];
  const [, indent, itemMarker, typedKey] = keyMatch;
  const place = placeOfLine(text, position.line, `${indent}${itemMarker}`, tagKeys, rootPath);
  if (!place) return [];
  const range = rangeOnLine(position.line, position.character - typedKey.length, position.character);
  const keyColumn = indent.length + itemMarker.length;
  const fields = fieldCompletions(parser, place, range, keyColumn);
  const itemValues = itemMarker && place.heldKeys.size === 0 ? valueCompletions(parser, place.path, range) : [];
  return [...fields, ...itemValues];
}

module.exports = {
  VALUE_KINDS,
  schemaCompletionsAt,
  placeOfLine,
  typedValueKeyOf,
  valueKindOf,
  offeredValuesOf,
  fieldRequirementOf,
  defaultValueTextAt,
};

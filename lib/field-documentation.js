const { schemaRendererFor } = require('./json-schema');
const { ANY_SHAPE, codeSpan, struckText } = require('./json-schema/render');

const MARKDOWN_EMPHASIS_CHARACTERS = /[\\*_`]/g;

function italicText(text) {
  return text.replace(MARKDOWN_EMPHASIS_CHARACTERS, '\\$&');
}
const { requirednessMarkerOf, writtenDescriptionOf } = require('./schema-checks');
const { fieldRequirementOf } = require('./schema-completion');
const { markdownWithoutHtml, schemaTextMarkdown } = require('./hover-heading');
const { THEME_ROLES, themeColorVariable } = require('./themes');

function isSchemaMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fieldNameOf(path) {
  let keyIndex = path.length - 1;
  while (keyIndex >= 0 && typeof path[keyIndex] === 'number') keyIndex -= 1;
  const itemIndexes = path.slice(keyIndex + 1).map((index) => `[${index}]`).join('');
  return `${keyIndex >= 0 ? path[keyIndex] : ''}${itemIndexes}`;
}

function editorRequirementOf(parser, path, node) {
  const key = path[path.length - 1];
  if (requirednessMarkerOf(node) || typeof key !== 'string') return null;
  return fieldRequirementOf(node, key, new Set(parser.requiredKeysAt(path.slice(0, -1))));
}

function acceptedFormMarkdown(acceptedForm, descriptionColor) {
  const line = markdownWithoutHtml(acceptedForm.line);
  const description = writtenDescriptionOf(acceptedForm);
  if (!description) return line;
  const underListItem = schemaTextMarkdown(description, descriptionColor).replace(/\n/g, '\n  ');
  return `${line}  \n  ${underListItem}`;
}

function fieldDocumentationOf(parser, path, theme) {
  const node = parser.writtenFieldSchemaAt(path);
  const renderer = schemaRendererFor(parser.root);
  if (!isSchemaMap(node) || !renderer) return null;
  const holdsAt = (holderPath) => (condition) => parser.conditionHoldsAt(holderPath, condition);
  const rendered = renderer.renderNode(node, holdsAt(path));
  const name = codeSpan(fieldNameOf(path));
  const declaration = rendered.shape === ANY_SHAPE ? name : `${name}: *${italicText(rendered.shape)}*`;
  const requirement = editorRequirementOf(parser, path, node);
  const shownRequirement = requirement && parser.readsFragment ? struckText(requirement) : requirement;
  const signature = shownRequirement ? `${declaration}    ${codeSpan(shownRequirement)}` : declaration;
  const sections = [markdownWithoutHtml(signature)];
  const description = writtenDescriptionOf(node);
  const descriptionColor = themeColorVariable(theme, THEME_ROLES.overlayHeading);
  if (description) sections.push(schemaTextMarkdown(description, descriptionColor));
  if (rendered.accepts.length > 0) {
    const acceptedForms = rendered.accepts.map((acceptedForm) => acceptedFormMarkdown(acceptedForm, descriptionColor));
    sections.push(['*Accepts:*', ...acceptedForms].join('\n'));
  }
  const stated = parser.defaultValueOf(node);
  const tags = stated ? [...rendered.tags, `*Default:* \`${JSON.stringify(stated.value)}\``] : rendered.tags;
  const deprecated = node.deprecated === true && parser.draft.readsDeprecated ? ['*Deprecated*'] : [];
  const key = path[path.length - 1];
  const parent = parser.nodeAt(path.slice(0, -1));
  const parentConditions = typeof key === 'string' && parent && parent !== true
    ? [
      ...renderer.keyDependencyLinesOf(parent, key),
      ...renderer.keyConditionLinesOf(parent, key, holdsAt(path.slice(0, -1))),
    ]
    : [];
  const tagLines = [...tags, ...rendered.conditions, ...parentConditions, ...deprecated];
  if (tagLines.length > 0) sections.push(markdownWithoutHtml(tagLines.join('  \n')));
  return sections.join('\n\n');
}

module.exports = { fieldDocumentationOf };

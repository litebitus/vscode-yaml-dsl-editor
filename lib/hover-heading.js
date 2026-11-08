const CODE_OR_TAG_START_PATTERN = /```[\s\S]*?```|(`+)[\s\S]*?\1(?!`)|</g;
const WORD_JOINER = '⁠';
const SCHEMA_NOTE_LABEL = '[schema]';
const PARAGRAPH_BREAK_PATTERN = /\n[ \t]*\n/;

function escapedHtmlText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hoverHeading(text, color) {
  return `<span style="color:${color};"><strong>${escapedHtmlText(text)}</strong></span>`;
}

function markdownWithoutHtml(markdown) {
  return String(markdown).replace(CODE_OR_TAG_START_PATTERN, (match) => (match === '<' ? '&lt;' : match));
}

function schemaNoteMarkdown(schemaNote, color) {
  const paragraphs = markdownWithoutHtml(schemaNote).split(PARAGRAPH_BREAK_PATTERN);
  return paragraphs
    .map((paragraph, index) => (index === 0 ? `<strong>${SCHEMA_NOTE_LABEL}</strong> ${paragraph}` : paragraph))
    .map((paragraph) => `<span style="color:${color};">${paragraph}</span>`)
    .join('\n\n');
}

function schemaNoteText(schemaNote) {
  return `${SCHEMA_NOTE_LABEL} ${schemaNote}`;
}

function termsWrappingBetween(terms) {
  return terms.map((term) => [...term].join(WORD_JOINER)).join(', ');
}

module.exports = {
  hoverHeading,
  markdownWithoutHtml,
  schemaNoteMarkdown,
  schemaNoteText,
  termsWrappingBetween,
};

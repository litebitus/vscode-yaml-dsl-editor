const OVERLAY_HEADING_COLOR = 'var(--vscode-yamlDslEditor-overlayHeadingForeground)';
const VALIDATION_ERRORS_HEADING_COLOR = 'var(--vscode-yamlDslEditor-validationErrorsHeadingForeground)';
const CODE_OR_TAG_START_PATTERN = /```[\s\S]*?```|(`+)[\s\S]*?\1(?!`)|</g;

function escapedHtmlText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hoverHeading(text, color) {
  return `<span style="color:${color};"><strong>${escapedHtmlText(text)}</strong></span>`;
}

function markdownWithoutHtml(markdown) {
  return String(markdown).replace(CODE_OR_TAG_START_PATTERN, (match) => (match === '<' ? '&lt;' : match));
}

module.exports = { OVERLAY_HEADING_COLOR, VALIDATION_ERRORS_HEADING_COLOR, hoverHeading, markdownWithoutHtml };

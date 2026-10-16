const test = require('node:test');
const assert = require('node:assert/strict');
const { hoverHeading, markdownWithoutHtml } = require('../lib/hover-heading');

test('a heading is its text in bold, in the color it is given, its HTML escaped', () => {
  assert.equal(
    hoverHeading('dev, <uat>', 'var(--vscode-mock-color)'),
    '<span style="color:var(--vscode-mock-color);"><strong>dev, &lt;uat&gt;</strong></span>',
  );
});

test('markdown keeps a tag outside code as text, and leaves code spans and fences as written', () => {
  const markdown = 'Keyed `name <install>:` per <env>.\n\n```\nmock: <value>\n```\n\nA ``double `<tick>` span`` and <b>bold</b>.';
  assert.equal(
    markdownWithoutHtml(markdown),
    'Keyed `name <install>:` per &lt;env>.\n\n```\nmock: <value>\n```\n\nA ``double `<tick>` span`` and &lt;b>bold&lt;/b>.',
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hoverHeading,
  markdownWithoutHtml,
  schemaNoteMarkdown,
  schemaNoteText,
  schemaTextMarkdown,
} = require('../lib/hover-heading');

test('schema text is each paragraph in the color it is given, with no label, as written and its HTML escaped', () => {
  assert.equal(
    schemaTextMarkdown('[~required] Mock: no `<color>` here, <b>.', 'var(--vscode-mock-color)'),
    '<span style="color:var(--vscode-mock-color);">[~required] Mock: no `<color>` here, &lt;b>.</span>',
  );
  assert.equal(
    schemaTextMarkdown('First paragraph.\n\nSecond paragraph.', 'var(--vscode-mock-color)'),
    '<span style="color:var(--vscode-mock-color);">First paragraph.</span>\n\n'
      + '<span style="color:var(--vscode-mock-color);">Second paragraph.</span>',
  );
});

test('a schema note is wholly in the color it is given, led by a bold [schema], its markdown kept and its HTML escaped', () => {
  assert.equal(
    schemaNoteMarkdown('Mock: no `<color>` here, <b>.', 'var(--vscode-mock-color)'),
    '<span style="color:var(--vscode-mock-color);"><strong>[schema]</strong> Mock: no `<color>` here, &lt;b>.</span>',
  );
  assert.equal(
    schemaNoteMarkdown('First paragraph.\n\nSecond paragraph.', 'var(--vscode-mock-color)'),
    '<span style="color:var(--vscode-mock-color);"><strong>[schema]</strong> First paragraph.</span>\n\n'
      + '<span style="color:var(--vscode-mock-color);">Second paragraph.</span>',
  );
  assert.equal(schemaNoteText('Mock: no `color` here.'), '[schema] Mock: no `color` here.');
});

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

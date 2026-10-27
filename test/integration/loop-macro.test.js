const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  typedAfter,
  completionItemsAt,
  definitionLineAt,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

function loopFixture(...parts) {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'loop-macro', ...parts);
}

function labelOf(item) {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

suite('loop macros', () => {
  isolateEachTest();

  test('a loop call is documented as the macro, its argument default shown in its signature', async () => {
    const doc = (await shownDocument(loopFixture('mock.yaml'))).document;
    await hoverTextBecomes(doc, positionInText(doc, 'fn.loop:', 3), [
      '```yaml-dsl-signature\nmacro loop(in: any, body: any, for?: list = ["it"])\n```',
      'Repeats the mock body once per item.',
      '- `in`: The mock collection.\n- `body`: The mock body.\n- `for`: The mock names.',
      '*Expands to:* `body` once per item of `in`, `for` bound to the item.',
    ].join('\n\n'));
  });

  test('an argument key is documented by its signature and description', async () => {
    const doc = (await shownDocument(loopFixture('mock.yaml'))).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'for: ["name"]', 1),
      '```yaml-dsl-signature\nfor?: list = ["it"]\n```\n\nThe mock names.',
    );
  });

  test('a loop variable in the body is documented as the loop\'s, bound to its items', async () => {
    const doc = (await shownDocument(loopFixture('mock.yaml'))).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, '${~it}-label', 3),
      '`it`: a loop variable of `labels fn.loop`, bound to `mock-a`, `mock-b`',
    );
  });

  test('a name a loop declares where its body lands resolves to the body\'s key', async () => {
    const doc = (await shownDocument(loopFixture('mock.yaml'))).document;
    assert.equal(
      await definitionLineAt(doc, positionInText(doc, 'ref mocktype.looped_a', 4)),
      positionInText(doc, '"${~name}":').line,
    );
  });

  test('a new key in a loop\'s arguments offers the arguments not yet written, a default as its value', async () => {
    const editor = await shownDocument(loopFixture('mock.yaml'));
    const cursor = await typedAfter(editor, 'in: local.mock_names', '\n      ');
    const items = await completionItemsAt(editor.document, cursor);
    const offered = items.find((item) => labelOf(item) === 'for');
    assert.ok(offered, items.map(labelOf).join(', '));
    assert.equal(offered.insertText.value, 'for: ${1:["it"]}');
    assert.ok(!items.some((item) => ['in', 'body', 'size'].includes(labelOf(item))), items.map(labelOf).join(', '));
  });

  test('a value typed in a loop\'s body offers its loop variables as the loop scope spells them', async () => {
    const editor = await shownDocument(loopFixture('mock.yaml'));
    const cursor = await typedAfter(editor, 'size: 1', '\n        source: ~');
    const labels = (await completionItemsAt(editor.document, cursor)).map(labelOf);
    assert.ok(labels.includes('~name'), labels.join(', '));
  });
});

suite('function call completion', () => {
  isolateEachTest();

  async function functionLabelsAfter(needle, typed) {
    const editor = await shownDocument(loopFixture('mock.yaml'));
    const cursor = await typedAfter(editor, needle, typed);
    return (await completionItemsAt(editor.document, cursor)).map(labelOf).filter((label) => label.startsWith('fn.'));
  }

  test('a key with no call marker typed is offered no function', async () => {
    assert.deepEqual(await functionLabelsAfter('size: 2', '\n    '), []);
  });

  test('a call with no name beside other keys is offered only the macros', async () => {
    assert.deepEqual(await functionLabelsAfter('size: 2', '\n    fn.'), ['fn.loop']);
  });

  test('a call with a name is offered every function and macro', async () => {
    assert.deepEqual((await functionLabelsAfter('size: 2', '\n    picks fn.')).sort(), ['fn.loop', 'fn.mock_join']);
  });

  test('a call with no name as a list item\'s only key is offered every function', async () => {
    const labels = await functionLabelsAfter('size: 2', '\n    picks:\n      - fn.');
    assert.deepEqual(labels.sort(), ['fn.loop', 'fn.mock_join']);
  });
});

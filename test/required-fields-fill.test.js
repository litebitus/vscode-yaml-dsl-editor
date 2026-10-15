const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_FIELDS_REQUEST,
  requiredFieldsSnippetText,
  fillRequiredFieldsAfterEnter,
} = require('../lib/required-fields-fill');

test('the snippet places a tab stop at each value, a pick list for values, an indented line for a map, and ends after the block', () => {
  const fields = [
    { key: 'name', valueKind: 'scalar', values: [] },
    { key: 'mode', valueKind: 'scalar', values: ['fast', 'a,b'] },
    { key: 'settings', valueKind: 'map', values: [] },
  ];
  assert.equal(requiredFieldsSnippetText(fields, 2, 2), [
    '    name: $1',
    '    mode: ${2|fast,a\\,b|}',
    '    settings:',
    '      $3$0',
  ].join('\n'));
  assert.equal(requiredFieldsSnippetText([{ key: 'cost$', valueKind: 'scalar', values: [] }], 0, 4), '    cost\\$: $1$0');
});

function documentOf(lines) {
  return {
    languageId: 'yaml-dsl',
    version: 1,
    uri: { toString: () => 'file:///repo/mock.yml' },
    lineAt: (line) => ({ text: lines[line], range: { line } }),
  };
}

function enterEvent(document, overrides = {}) {
  return {
    document,
    reason: undefined,
    contentChanges: [{ rangeLength: 0, text: '\n    ', range: { start: { line: 1 } } }],
    ...overrides,
  };
}

function fillingVscode(document) {
  const inserted = [];
  const editor = {
    document,
    options: { tabSize: 2 },
    insertSnippet: async (snippet, range, options) => { inserted.push({ snippet: snippet.value, range, options }); },
  };
  return {
    inserted,
    window: { activeTextEditor: editor },
    SnippetString: class {
      constructor(value) { this.value = value; }
    },
  };
}

test('Enter after a key line asks the server and inserts the fields as one undo step over the new line', async () => {
  const document = documentOf(['queue:', '  alerts:', '    ']);
  const vscode = fillingVscode(document);
  const asked = [];
  const client = {
    sendRequest: async (method, params) => {
      asked.push([method, params]);
      return { keyColumn: 2, fields: [{ key: 'name', valueKind: 'scalar', values: [] }] };
    },
  };
  await fillRequiredFieldsAfterEnter(vscode, client, enterEvent(document));
  assert.deepEqual(asked, [[REQUIRED_FIELDS_REQUEST, { uri: 'file:///repo/mock.yml', line: 1 }]]);
  assert.deepEqual(vscode.inserted, [{
    snippet: '    name: $1$0',
    range: { line: 2 },
    options: { undoStopBefore: true, undoStopAfter: false, keepWhitespace: true },
  }]);
});

test('typing other than Enter after a key, an undo, a text changed meanwhile, or no fields inserts nothing', async () => {
  const document = documentOf(['queue:', '  alerts: mock', '    ']);
  const vscode = fillingVscode(document);
  let answer = { keyColumn: 2, fields: [{ key: 'name', valueKind: 'scalar', values: [] }] };
  const client = { sendRequest: async () => answer };
  await fillRequiredFieldsAfterEnter(vscode, client, enterEvent(document));
  const keyDocument = documentOf(['queue:', '  alerts:', '    ']);
  const keyVscode = fillingVscode(keyDocument);
  await fillRequiredFieldsAfterEnter(keyVscode, client, enterEvent(keyDocument, { reason: 1 }));
  await fillRequiredFieldsAfterEnter(keyVscode, client, enterEvent(keyDocument, {
    contentChanges: [{ rangeLength: 0, text: 'x', range: { start: { line: 1 } } }],
  }));
  const changingClient = { sendRequest: async () => { keyDocument.version += 1; return answer; } };
  await fillRequiredFieldsAfterEnter(keyVscode, changingClient, enterEvent(keyDocument));
  answer = { keyColumn: 2, fields: [] };
  await fillRequiredFieldsAfterEnter(keyVscode, client, enterEvent(keyDocument));
  answer = null;
  await fillRequiredFieldsAfterEnter(keyVscode, client, enterEvent(keyDocument));
  assert.deepEqual([...vscode.inserted, ...keyVscode.inserted], []);
});

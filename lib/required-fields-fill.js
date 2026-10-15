const REQUIRED_FIELDS_REQUEST = 'yaml-dsl/requiredFields';
const ENTER_WITH_INDENT = /^\r?\n[ \t]*$/;
const KEY_WITHOUT_VALUE = /:\s*(?:#.*)?$/;
const SCALAR_VALUE_KIND = 'scalar';

function snippetTextOf(text) {
  return String(text).replace(/[$}\\]/g, '\\$&');
}

function snippetChoiceOf(text) {
  return String(text).replace(/[$}\\,|]/g, '\\$&');
}

function requiredFieldsSnippetText(fields, keyColumn, indentWidth) {
  const fieldIndent = ' '.repeat(keyColumn + indentWidth);
  const nestedIndent = ' '.repeat(keyColumn + 2 * indentWidth);
  const lines = fields.flatMap((field, index) => {
    const tabstop = index + 1;
    const key = snippetTextOf(field.key);
    if (field.valueKind !== SCALAR_VALUE_KIND) return [`${fieldIndent}${key}:`, `${nestedIndent}$${tabstop}`];
    if (field.values.length > 0) {
      return [`${fieldIndent}${key}: \${${tabstop}|${field.values.map(snippetChoiceOf).join(',')}|}`];
    }
    return [`${fieldIndent}${key}: $${tabstop}`];
  });
  return `${lines.join('\n')}$0`;
}

function enteredAfterKeyLine(event) {
  const { document } = event;
  if (!document || document.languageId !== 'yaml-dsl' || event.reason !== undefined) return null;
  if (event.contentChanges.length !== 1) return null;
  const [change] = event.contentChanges;
  if (change.rangeLength !== 0 || !ENTER_WITH_INDENT.test(change.text)) return null;
  const keyLine = change.range.start.line;
  return KEY_WITHOUT_VALUE.test(document.lineAt(keyLine).text) ? keyLine : null;
}

async function fillRequiredFieldsAfterEnter(vscode, client, event) {
  const keyLine = enteredAfterKeyLine(event);
  if (keyLine === null) return;
  const { document } = event;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) return;
  const version = document.version;
  const answer = await client.sendRequest(REQUIRED_FIELDS_REQUEST, { uri: document.uri.toString(), line: keyLine })
    .catch(() => null);
  if (!answer || answer.fields.length === 0) return;
  if (document.version !== version || vscode.window.activeTextEditor !== editor) return;
  const indentWidth = Number(editor.options.tabSize) || 2;
  const snippet = new vscode.SnippetString(requiredFieldsSnippetText(answer.fields, answer.keyColumn, indentWidth));
  await editor.insertSnippet(snippet, document.lineAt(keyLine + 1).range, {
    undoStopBefore: true,
    undoStopAfter: false,
    keepWhitespace: true,
  });
}

module.exports = { REQUIRED_FIELDS_REQUEST, requiredFieldsSnippetText, fillRequiredFieldsAfterEnter };

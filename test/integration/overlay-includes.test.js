const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, shownDocument, positionInText, hoverTextBecomes } = require('./editor-hints');

function includesFixture(...parts) {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'includes', ...parts);
}

async function eventually(read, matches) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let value = await read();
  while (!matches(value) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    value = await read();
  }
  return value;
}

suite('overlay includes', () => {
  test('a template opens its common layer from the include and resolves the names it declares', async () => {
    const template = (await shownDocument(includesFixture('mock-bucket.yaml'))).document;
    const snippetUri = vscode.Uri.file(includesFixture('snippets', 'mock-wait.yaml')).toString();
    const links = await eventually(
      () => vscode.commands.executeCommand('vscode.executeLinkProvider', template.uri),
      (found) => (found || []).some((link) => link.target && link.target.toString() === snippetUri),
    );
    const locationLink = links.find((link) => link.target && link.target.toString() === snippetUri);
    assert.ok(locationLink);
    assert.equal(locationLink.range.start.line, positionInText(template, 's3://mock-bucket').line);
    const definitions = await eventually(
      () => vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider',
        template.uri,
        positionInText(template, '!Ref MockWait', 6),
      ),
      (found) => (found || []).length === 1,
    );
    const target = definitions[0].targetUri || definitions[0].uri;
    assert.equal(target.toString(), snippetUri);
  });

  test('a common layer documents a field at the place its overlay merges it', async () => {
    await shownDocument(includesFixture('mock-bucket.yaml'));
    const snippet = (await shownDocument(includesFixture('snippets', 'mock-wait.yaml'))).document;
    await hoverTextBecomes(
      snippet,
      positionInText(snippet, 'Type', 1),
      '```\nType: string    [optional]\n```\n\nThe resource type.',
    );
  });
});

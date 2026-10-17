const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, shownDocument, positionInText, hoverTextBecomes } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

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
  isolateEachTest();

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

  test('an include calls a merge macro, its callee documented by what it expands to', async () => {
    const template = (await shownDocument(includesFixture('mock-bucket.yaml'))).document;
    await hoverTextBecomes(
      template,
      positionInText(template, 'AWS::Include', 2),
      '```yaml-dsl-signature\nmacro AWS::Include(Location: text)\n```\n\nInserts the mock snippet in its place.\n\n'
        + '- `Location`: The mock snippet\'s location.\n\n'
        + '*Expands to:* the map holding the call, joined with the content at `Location`.',
    );
  });

  test('a fragment is documented from the schema node its modeline names, its requirement marker struck', async () => {
    const fragment = (await shownDocument(includesFixture('snippets', 'mock-alone.yaml'))).document;
    const struckRequired = [...'[required]'].map((character) => `${character}̶`).join('');
    await hoverTextBecomes(
      fragment,
      positionInText(fragment, 'Type', 1),
      `\`Type\`: *string*    \`${struckRequired}\`\n\nThe resource type.`,
    );
  });

  test('a common layer documents a field at the place its overlay merges it', async () => {
    await shownDocument(includesFixture('mock-bucket.yaml'));
    const snippet = (await shownDocument(includesFixture('snippets', 'mock-wait.yaml'))).document;
    await hoverTextBecomes(
      snippet,
      positionInText(snippet, 'Type', 1),
      '`Type`: *string*    `[required]`\n\nThe resource type.',
    );
  });
});

const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  positionInText,
  hoverTextOf,
  hoverTextHolds,
  completionItemsAt,
  definitionLineAt,
  typedAfter,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

async function offeredDocumentationOf(doc, position, label) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let documentation = '';
  while (Date.now() < deadline) {
    const items = await completionItemsAt(doc, position);
    const item = items.find((offered) => (typeof offered.label === 'string' ? offered.label : offered.label.label) === label);
    documentation = item && item.documentation ? item.documentation.value : '';
    if (documentation) return documentation;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return documentation;
}

suite('CloudFormation templates', () => {
  isolateEachTest();

  test('a resource\'s properties are documented by its Type '
    + 'while the template schema compiles in the worker', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const template = path.join(fixtures, 'cloudformation-template', 'mock-template.yaml');
    const doc = (await shownDocument(template)).document;
    await hoverTextHolds(doc, positionInText(doc, 'BucketName'), 'A name for the bucket.');
    await hoverTextHolds(doc, positionInText(doc, 'VisibilityTimeout'), 'VisibilityTimeout');
  });

  test('a property under a list item, under an object, or written as an intrinsic function is documented, '
    + 'and a resource names only the branch its Type selects', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'))).document;
    await hoverTextHolds(doc, positionInText(doc, 'KeyType'), '`KeyType`: *string*');
    await hoverTextHolds(doc, positionInText(doc, 'ReadCapacityUnits'), 'ReadCapacityUnits');
    await hoverTextHolds(doc, positionInText(doc, 'AttributeName'), '`AttributeName`: *ref*');
    const resourceHover = '*When* `Type` is `"AWS::DynamoDB::Table"`: '
      + '`Properties` required; `Properties` is a `AWS::DynamoDB::Table`.';
    await hoverTextHolds(doc, positionInText(doc, 'MockTable'), resourceHover);
    const repeated = await hoverTextOf(doc, positionInText(doc, 'MockTable'));
    assert.equal(repeated.split('*When*').length, 2, repeated);
  });

  test('a resource key offered by completion carries the description its Type\'s branch restates without one', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'));
    const cursor = await typedAfter(editor, 'Type: AWS::SQS::Queue', '\n    Pr');
    assert.equal(
      await offeredDocumentationOf(editor.document, cursor, 'Properties'),
      'The properties of the resource, by its type.',
    );
  });

  test('a function offered after the call marker is documented by its signature and description', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'));
    const cursor = await typedAfter(editor, 'Value: !GetAtt MockQueue.Arn', '\n  MockJoined:\n    Value:\n      Fn::Jo');
    const documentation = await offeredDocumentationOf(editor.document, cursor, 'Fn::Join');
    assert.ok(documentation.startsWith([
      '```yaml-dsl-signature',
      'Join(delimiter: text, values: list): text',
      '```',
      '',
      'Joins a list of values into one value, separated by the delimiter.',
    ].join('\n')), documentation);
  });

  test('a function is offered from its name typed without the call marker', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'));
    const cursor = await typedAfter(editor, 'Value: !GetAtt MockQueue.Arn', '\n  MockJoined:\n    Value:\n      jo');
    const labels = (await completionItemsAt(editor.document, cursor))
      .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.ok(labels.includes('Fn::Join'), labels.join(', '));
  });

  test('a value starting with `!` is offered the tags the config declares', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'));
    const cursor = await typedAfter(editor, 'Value: !GetAtt MockQueue.Arn', '\n  MockTagged:\n    Value: !');
    const labels = (await completionItemsAt(editor.document, cursor))
      .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.deepEqual(labels.filter((label) => label.startsWith('!')).sort(), ['!GetAtt', '!Ref']);
  });

  test('typing `!` where a value starts opens the list on its own', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'));
    const cursor = await typedAfter(editor, 'Value: !GetAtt MockQueue.Arn', '\n  MockTyped:\n    Value: ');
    editor.selection = new vscode.Selection(cursor, cursor);
    await vscode.commands.executeCommand('type', { text: '!' });
    const typedLine = () => editor.document.lineAt(cursor.line).text;
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    while (Date.now() < deadline && !/^ {4}Value: ![A-Za-z]/.test(typedLine())) {
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await vscode.commands.executeCommand('acceptSelectedSuggestion');
    }
    assert.match(typedLine(), /^ {4}Value: ![A-Za-z]/);
  });

  test('a function_call macro\'s callee typed macro is completed from the table\'s macros only', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'));
    const cursor = await typedAfter(editor, 'Resources:', '\n  Fn::Transform:\n    Name: AWS::');
    const includeDocumentation = await offeredDocumentationOf(editor.document, cursor, 'AWS::Include');
    assert.ok(includeDocumentation.startsWith([
      '```yaml-dsl-signature',
      'macro AWS::Include(Location: text)',
      '```',
      '',
      'Inserts the template snippet stored in Amazon S3 in its place, merged with the map holding the call.',
    ].join('\n')), includeDocumentation);
    const labels = (await completionItemsAt(editor.document, cursor))
      .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.ok(!labels.includes('Join'), labels.join(', '));
  });

  test('an intrinsic function in an output\'s value is documented', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-template.yaml'))).document;
    await hoverTextHolds(doc, positionInText(doc, '!GetAtt', 1),'Returns the value of an attribute of a resource');
  });

  test('a Fn::ForEach loop standing among resources by its suffixed name is documented as a macro', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'))).document;
    await hoverTextHolds(
      doc,
      positionInText(doc, 'ForEach::Topics'),
      'macro ForEach(identifier: text, collection: list, fragment: map)',
    );
    await hoverTextHolds(
      doc,
      positionInText(doc, 'ForEach::Topics'),
      '*Expands to:* `fragment` once per item of `collection`, `identifier` bound to the item.',
    );
  });

  test('a Fn::ForEach body is documented where it lands, and its loop variable as the loop\'s', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'))).document;
    await hoverTextHolds(
      doc,
      positionInText(doc, 'DisplayName'),
      'The display name to use for an SNS topic with SMS subscriptions.',
    );
    await hoverTextHolds(
      doc,
      positionInText(doc, '${TopicName}', 2),
      '`TopicName`: the loop variable of `Fn::ForEach::Topics`, bound to `MockA`, `MockB`',
    );
  });

  test('a placeholder opened in a loop\'s body offers its loop variable, in either of the pattern\'s openings', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'));
    const documentation = '`TopicName`: the loop variable of `Fn::ForEach::Topics`, bound to `MockA`, `MockB`';
    const dollarCursor = await typedAfter(editor, 'DisplayName: mock-${TopicName}', '\n          FifoTopic: ${');
    assert.equal(await offeredDocumentationOf(editor.document, dollarCursor, '${TopicName}'), documentation);
    const ampersandCursor = await typedAfter(editor, 'FifoTopic: ${', '\n          ContentBasedDeduplication: &{');
    assert.equal(await offeredDocumentationOf(editor.document, ampersandCursor, '&{TopicName}'), documentation);
  });

  test('accepting a placeholder entry before an auto-closed brace writes one closing brace', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const editor = await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'));
    const lineEnd = await typedAfter(editor, 'DisplayName: mock-${TopicName}', '\n          FifoTopic: ${TopicN}');
    const cursor = lineEnd.translate(0, -1);
    editor.selection = new vscode.Selection(cursor, cursor);
    await completionItemsAt(editor.document, cursor);
    const typedLine = () => editor.document.lineAt(cursor.line).text;
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    while (Date.now() < deadline && typedLine() !== '          FifoTopic: ${TopicName}') {
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await vscode.commands.executeCommand('acceptSelectedSuggestion');
    }
    assert.equal(typedLine(), '          FifoTopic: ${TopicName}');
  });

  test('a name a loop in another loop\'s body declares resolves to that body\'s key', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'))).document;
    assert.equal(
      await definitionLineAt(doc, positionInText(doc, '${BucketEastLogs}', 4)),
      positionInText(doc, 'Bucket&{Region}&{Kind}').line,
    );
  });

  test('the template\'s Transform section calls the Transform macro, documented with its callee', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'))).document;
    await hoverTextHolds(
      doc,
      positionInText(doc, 'Transform:'),
      'macro Transform(Name: macro, Parameters?: map)',
    );
    await hoverTextHolds(
      doc,
      positionInText(doc, 'Transform:'),
      '*Expands to:* a call of the macro or function `Name` names, `Parameters` its arguments by name.',
    );
  });
});

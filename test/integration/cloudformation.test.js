const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  positionInText,
  hoverTextOf,
  completionItemsAt,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

async function hoverTextHolds(doc, position, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let text = '';
  while (Date.now() < deadline) {
    text = await hoverTextOf(doc, position);
    if (text.includes(expected)) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.ok(text.includes(expected), text);
}

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

async function typedAfter(editor, needle, text) {
  const doc = editor.document;
  const lineEnd = doc.lineAt(positionInText(doc, needle).line).range.end;
  await editor.edit((edit) => { edit.insert(lineEnd, text); });
  return doc.lineAt(lineEnd.line + text.split('\n').length - 1).range.end;
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

  test('a function_call macro\'s callee is completed from every function and macro the table holds', async () => {
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
    const joinDocumentation = await offeredDocumentationOf(editor.document, cursor, 'Join');
    assert.ok(joinDocumentation.startsWith('```yaml-dsl-signature\nJoin(delimiter: text, values: list): text'));
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
      '*Expands to:* `fragment` once per item of `collection`, the item standing for `identifier`.',
    );
  });

  test('a Fn::ForEach body is documented where it lands, and its identifier as the loop\'s', async () => {
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
      '`TopicName`: the identifier of `Fn::ForEach::Topics`, standing for `MockA`, `MockB`',
    );
  });

  test('the template\'s Transform section calls the Transform macro, documented with its callee', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = (await shownDocument(path.join(fixtures, 'cloudformation-template', 'mock-loop.yaml'))).document;
    await hoverTextHolds(
      doc,
      positionInText(doc, 'Transform:'),
      'macro Transform(Name: text, Parameters?: map)',
    );
    await hoverTextHolds(
      doc,
      positionInText(doc, 'Transform:'),
      '*Expands to:* a call of the macro or function `Name` names, `Parameters` its arguments by name.',
    );
  });
});

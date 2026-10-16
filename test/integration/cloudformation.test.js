const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  positionInText,
  hoverTextOf,
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
});

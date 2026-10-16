const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  fixtureCopy,
  positionInText,
  hoverTextBecomes,
} = require('./editor-hints');

const BRANCH_FIELDS = ['BucketName', 'QueueName'];

const labelOf = (item) => (typeof item.label === 'string' ? item.label : item.label.label);

async function offeredBranchFieldsBecome(doc, position, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let offered = [];
  while (Date.now() < deadline) {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, position);
    offered = (list ? list.items : []).map(labelOf).filter((label) => BRANCH_FIELDS.includes(label)).sort();
    if (JSON.stringify(offered) === JSON.stringify(expected)) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.deepEqual(offered, expected);
}

suite('branches the document selects', () => {
  test('a field is documented by the branch its entry\'s value selects', async () => {
    const doc = (await shownDocument(path.join(fixtureCopy('branched', 'branched-hover'), 'mock.yaml'))).document;
    await hoverTextBecomes(
      doc,
      positionInText(doc, 'BucketName', 1),
      '```\nBucketName: string    [optional]\n```\n\nThe bucket name.',
    );
  });

  test('a key typed in an entry is offered the fields of the branch its value selects', async () => {
    const editor = await shownDocument(path.join(fixtureCopy('branched', 'branched-completion'), 'mock.yaml'));
    const doc = editor.document;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await editor.edit((edit) => { edit.insert(end, '      Na'); });
    await offeredBranchFieldsBecome(doc, doc.lineAt(doc.lineCount - 1).range.end, ['QueueName']);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});

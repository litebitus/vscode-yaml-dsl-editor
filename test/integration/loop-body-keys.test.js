const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  positionInText,
  extensionClient,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const SAME_KEY_WARNING = 'the loop body\'s key `mock_shared` reads no loop variable, '
  + 'so every pass writes the same key';

function loopBodyKeysFixture() {
  return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'loop-body-keys', 'mock-body.yaml');
}

async function paintedProblemsOf(doc) {
  const answer = await (await extensionClient())
    .sendRequest('yaml-dsl/decorations', { uri: doc.uri.toString() });
  return answer.problems.map((problem) => [problem.range.start.line, problem.severity, problem.message]);
}

suite('loop body keys', () => {
  isolateEachTest();

  test('a loop body\'s key that reads no loop variable is a warning at the key, '
    + 'while a sibling key that reads the loop variable raises nothing', async () => {
    const doc = (await shownDocument(loopBodyKeysFixture())).document;
    const expected = [[positionInText(doc, 'mock_shared:').line, 'warning', SAME_KEY_WARNING]];
    const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
    let painted = [];
    while (Date.now() < deadline) {
      painted = await paintedProblemsOf(doc);
      if (JSON.stringify(painted) === JSON.stringify(expected)) break;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.deepEqual(painted, expected);
  });
});

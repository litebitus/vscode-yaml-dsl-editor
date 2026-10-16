const assert = require('assert');
const path = require('path');
const vscode = require('vscode');
const { shownDocument } = require('./editor-hints');

const DIFF_COMMAND = 'yaml-dsl-editor.diffAcrossOverlays';
const CHOOSE_COMMAND = 'yaml-dsl-editor.chooseDiffOverlays';
const DIFF_SCHEME = 'yaml-dsl-overlay-diff';
const WAIT_MILLISECONDS = 3000;
const contributes = require('../../package.json').contributes;
const { isolateEachTest } = require('./test-isolation');

function concernPath(...segments) {
  return path.join(vscode.workspace.workspaceFolders[2].uri.fsPath, ...segments);
}

async function waitFor(answer, describe) {
  const deadline = Date.now() + WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const found = await answer();
    if (found) return found;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.fail(`timed out waiting for ${describe}`);
  return null;
}

function diffEditorShowing(expectedText) {
  return waitFor(
    () => vscode.window.visibleTextEditors.find((visible) => visible.document.uri.scheme === DIFF_SCHEME
      && visible.document.getText() === expectedText),
    'the diff editor',
  );
}

const queueDiff = [
  '# overlay-1, overlay-2: 2 differences',
  'mocktype:',
  '  queue:',
  '    name: mock-queue',
  '    size: 10  # overlay-1',
  '    size: 20  # overlay-2',
  '    retry:',
  '      attempts: 3  # overlay-1',
  '      attempts:  # overlay-2',
  '',
].join('\n');

suite('overlay diff', () => {
  isolateEachTest();

  test('the title-bar button shows on every DSL file on disk and opens the diff at once', async () => {
    const button = contributes.menus['editor/title'].find((item) => item.command === DIFF_COMMAND);
    assert.equal(button.when, 'resourceLangId == yaml-dsl && resourceScheme == file');
    assert.equal(contributes.commands.find((command) => command.command === DIFF_COMMAND).icon, '$(diff)');
    const editor = await shownDocument(concernPath('diff-group', 'overlay-1', 'diffed', 'mock.yml'));
    editor.selection = new vscode.Selection(1, 0, 5, 0);
    await vscode.commands.executeCommand(DIFF_COMMAND, editor.document.uri);
    const diffEditor = await diffEditorShowing(queueDiff);
    assert.equal(diffEditor.document.uri.path, '/diff-group／diffed');
    assert.equal(diffEditor.document.languageId, 'yaml-dsl-overlay-diff');
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.deepEqual(vscode.languages.getDiagnostics(diffEditor.document.uri), []);
  });

  test('the title-bar button with nothing selected diffs the key on the cursor\'s line', async () => {
    const editor = await shownDocument(concernPath('diff-group', 'overlay-1', 'diffed', 'mock.yml'));
    editor.selection = new vscode.Selection(2, 4, 2, 4);
    await vscode.commands.executeCommand(DIFF_COMMAND, editor.document.uri);
    await diffEditorShowing([
      '# overlay-1, overlay-2: 1 difference',
      'mocktype:',
      '  queue:',
      '    size: 10  # overlay-1',
      '    size: 20  # overlay-2',
      '',
    ].join('\n'));
  });

  test('the context menu entry diffs the selected key of the file it was opened on', async () => {
    const entry = contributes.menus['editor/context'].find((item) => item.command === DIFF_COMMAND);
    assert.equal(entry.group, 'navigation');
    const editor = await shownDocument(concernPath('diff-group', 'overlay-1', 'diffed', 'mock.yml'));
    editor.selection = new vscode.Selection(2, 0, 2, 12);
    await vscode.commands.executeCommand(entry.command, editor.document.uri);
    await diffEditorShowing([
      '# overlay-1, overlay-2: 1 difference',
      'mocktype:',
      '  queue:',
      '    size: 10  # overlay-1',
      '    size: 20  # overlay-2',
      '',
    ].join('\n'));
  });

  test('an open diff follows the selection, also into another overlay\'s file of the stack', async () => {
    const editor = await shownDocument(concernPath('diff-group', 'overlay-1', 'diffed', 'mock.yml'));
    editor.selection = new vscode.Selection(1, 0, 5, 0);
    await vscode.commands.executeCommand(DIFF_COMMAND, editor.document.uri);
    await diffEditorShowing(queueDiff);
    const otherOverlay = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(concernPath('diff-group', 'overlay-2', 'diffed', 'mock.yml')),
      { viewColumn: editor.viewColumn },
    );
    otherOverlay.selection = new vscode.Selection(2, 0, 2, 12);
    await diffEditorShowing([
      '# overlay-1, overlay-2: 1 difference',
      'mocktype:',
      '  queue:',
      '    size: 10  # overlay-1',
      '    size: 20  # overlay-2',
      '',
    ].join('\n'));
  });

  test('the diff tab\'s button, clicked in the focused view, renders the same view again in place', async () => {
    const button = contributes.menus['editor/title'].find((item) => item.command === CHOOSE_COMMAND);
    assert.equal(button.when, 'resourceScheme == yaml-dsl-overlay-diff');
    const editor = await shownDocument(concernPath('diff-group', 'overlay-1', 'diffed', 'mock.yml'));
    editor.selection = new vscode.Selection(1, 0, 5, 0);
    await vscode.commands.executeCommand(DIFF_COMMAND, editor.document.uri);
    const diffEditor = await diffEditorShowing(queueDiff);
    const focusedDiff = await vscode.window.showTextDocument(diffEditor.document, diffEditor.viewColumn);
    const groupCount = vscode.window.tabGroups.all.length;
    const choosing = vscode.commands.executeCommand(CHOOSE_COMMAND, focusedDiff.document.uri);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await choosing;
    await diffEditorShowing(queueDiff);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const diffTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.input && tab.input.uri && tab.input.uri.scheme === DIFF_SCHEME);
    assert.equal(vscode.window.tabGroups.all.length, groupCount);
    assert.equal(diffTabs.length, 1);
    assert.equal(diffTabs[0].group.viewColumn, focusedDiff.viewColumn);
  });
});

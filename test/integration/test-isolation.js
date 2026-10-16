const vscode = require('vscode');

async function editorsReset() {
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  for (const document of vscode.workspace.textDocuments.filter((held) => held.isDirty)) {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function isolateEachTest() {
  setup(editorsReset);
  teardown(editorsReset);
}

module.exports = { isolateEachTest };

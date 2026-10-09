const SHOW_DECLARATIONS_COMMAND = 'yaml-dsl-editor.showDeclarations';
const SHOW_HOVER_COMMAND = 'editor.action.showHover';

function sameLocation(left, right) {
  return left.uri === right.uri && left.line === right.line && left.character === right.character;
}

function createDeclarationsPopup(vscode) {
  let openingAt = null;

  function declarationsLink(document, link) {
    if (!link || !link.data || !(link.data.targetCount > 1)) return link;
    const { line, character } = link.range.start;
    const argument = encodeURIComponent(JSON.stringify([{ uri: document.uri.toString(), line, character }]));
    link.target = vscode.Uri.parse(`command:${SHOW_DECLARATIONS_COMMAND}?${argument}`);
    return link;
  }

  async function show(location) {
    const editor = vscode.window.activeTextEditor;
    if (!location || !editor || editor.document.uri.toString() !== location.uri) return;
    const position = new vscode.Position(location.line, location.character);
    editor.selection = new vscode.Selection(position, position);
    openingAt = location;
    await vscode.commands.executeCommand(SHOW_HOVER_COMMAND);
  }

  function opensHoverAt(document, position) {
    const asked = { uri: document.uri.toString(), line: position.line, character: position.character };
    if (!openingAt || !sameLocation(openingAt, asked)) return false;
    openingAt = null;
    return true;
  }

  return { declarationsLink, show, opensHoverAt };
}

module.exports = { SHOW_DECLARATIONS_COMMAND, createDeclarationsPopup };

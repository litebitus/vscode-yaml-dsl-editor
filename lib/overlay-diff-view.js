const {
  OVERLAY_DIFF_COMMAND,
  OVERLAY_DIFF_TITLE,
  CHOOSE_DIFF_OVERLAYS_COMMAND,
  CHOOSE_DIFF_OVERLAYS_TITLE,
} = require('./overlay-diff-command');
const { DARK_THEME, overlayDiffRole, themeColorId } = require('./themes');

const OVERLAY_DIFF_SCHEME = 'yaml-dsl-overlay-diff';
const OVERLAY_DIFF_LANGUAGE = 'yaml-dsl-overlay-diff';
const OVERLAY_DIFF_PALETTE_SIZE = 6;
const DSL_LANGUAGE = 'yaml-dsl';
const TITLE_PATH_SEPARATOR = '／';
const DIFFERENCE_MARKER = '~';
const MARKER_COLUMN_WIDTH = '2ch';
const SELECTION_FOLLOW_DELAY_MILLISECONDS = 200;

function overlayDiffUri(vscode, title) {
  return vscode.Uri.from({ scheme: OVERLAY_DIFF_SCHEME, path: `/${title.replaceAll('/', TITLE_PATH_SEPARATOR)}` });
}

function overlayDiffText(diff) {
  return `${diff.lines.map((line) => line.text).join('\n')}\n`;
}

function serializableRange(range) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function overlayDiffColorIds(theme) {
  return Array.from(
    { length: OVERLAY_DIFF_PALETTE_SIZE },
    (_, index) => themeColorId(theme, overlayDiffRole(index + 1)),
  );
}

function createOverlayDiffViews(vscode, client, theme = DARK_THEME, timerFunctions = { setTimeout, clearTimeout }) {
  const viewsByUri = new Map();
  const changes = new vscode.EventEmitter();
  const decorationType = (options) => vscode.window.createTextEditorDecorationType(options);
  const colorTypesOf = (chosenTheme) => overlayDiffColorIds(chosenTheme).map((colorId) => decorationType({
    backgroundColor: new vscode.ThemeColor(colorId),
    isWholeLine: true,
  }));
  let colorTypes = colorTypesOf(theme);
  const struckType = decorationType({ textDecoration: 'line-through' });
  const markerType = decorationType({ before: { contentText: DIFFERENCE_MARKER, width: MARKER_COLUMN_WIDTH } });
  const spacerType = decorationType({ before: { contentText: ' ', width: MARKER_COLUMN_WIDTH } });

  function paint(editor) {
    const view = editor && editor.document ? viewsByUri.get(editor.document.uri.toString()) : null;
    if (!view) return;
    const rangesByColor = colorTypes.map(() => []);
    const struckRanges = [];
    const markerRanges = [];
    const spacerRanges = [];
    view.diff.lines.forEach((line, lineIndex) => {
      const lineStart = new vscode.Range(lineIndex, 0, lineIndex, 0);
      if (line.differenceIndex === null) {
        spacerRanges.push(lineStart);
        return;
      }
      markerRanges.push(lineStart);
      const wholeLine = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);
      rangesByColor[line.differenceIndex % colorTypes.length].push(wholeLine);
      if (line.struck) {
        struckRanges.push(new vscode.Range(lineIndex, line.struck.start, lineIndex, line.struck.end));
      }
    });
    colorTypes.forEach((colorType, index) => editor.setDecorations(colorType, rangesByColor[index]));
    editor.setDecorations(struckType, struckRanges);
    editor.setDecorations(markerType, markerRanges);
    editor.setDecorations(spacerType, spacerRanges);
  }

  function paintVisible() {
    for (const editor of vscode.window.visibleTextEditors || []) paint(editor);
  }

  function applyTheme(chosenTheme) {
    for (const colorType of colorTypes) colorType.dispose();
    colorTypes = colorTypesOf(chosenTheme);
    paintVisible();
  }

  async function updateView(target, overlayNames, checkedOverlayNames) {
    const diff = await client.sendRequest('yaml-dsl/overlayDiff', { ...target, overlayNames: checkedOverlayNames });
    if (!diff) return null;
    const uri = overlayDiffUri(vscode, diff.title);
    viewsByUri.set(uri.toString(), { diff, target, overlayNames, checkedOverlayNames });
    changes.fire(uri);
    return uri;
  }

  async function render(target, overlayNames, checkedOverlayNames) {
    const uri = await updateView(target, overlayNames, checkedOverlayNames);
    if (!uri) return;
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== OVERLAY_DIFF_LANGUAGE) {
      doc = await vscode.languages.setTextDocumentLanguage(doc, OVERLAY_DIFF_LANGUAGE);
    }
    const shownOptions = { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true };
    paint(await vscode.window.showTextDocument(doc, shownOptions));
  }

  async function warnOnFailure(work) {
    try {
      await work();
    } catch (error) {
      vscode.window.showWarningMessage(`${OVERLAY_DIFF_TITLE}: ${error.message}`);
    }
  }

  function diffAcrossOverlays(target) {
    const editor = vscode.window.activeTextEditor;
    const chosen = target && typeof target.uri === 'string'
      ? target
      : editor && { uri: editor.document.uri.toString(), range: serializableRange(editor.selection) };
    if (!chosen) return Promise.resolve();
    return warnOnFailure(async () => {
      const stack = await client.sendRequest('yaml-dsl/overlayDiffStack', { uri: chosen.uri });
      if (!stack || stack.overlayNames.length === 0) return;
      await render(chosen, stack.overlayNames, stack.overlayNames);
    });
  }

  let followTimer = null;
  let followRequestCount = 0;

  function selectsInDslFile(editor) {
    return Boolean(editor && editor.document && editor.document.languageId === DSL_LANGUAGE
      && editor.document.uri.scheme === 'file' && editor.selection && !editor.selection.isEmpty);
  }

  function shownViewUris() {
    return new Set((vscode.window.visibleTextEditors || [])
      .filter((editor) => editor.document && viewsByUri.has(editor.document.uri.toString()))
      .map((editor) => editor.document.uri.toString()));
  }

  async function follow(target, requestNumber) {
    await warnOnFailure(async () => {
      const stack = await client.sendRequest('yaml-dsl/overlayDiffStack', { uri: target.uri });
      if (!stack || requestNumber !== followRequestCount) return;
      const viewKey = overlayDiffUri(vscode, stack.title).toString();
      const view = viewsByUri.get(viewKey);
      if (!view || !shownViewUris().has(viewKey)) return;
      const checkedOverlayNames = view.checkedOverlayNames
        .filter((overlayName) => stack.overlayNames.includes(overlayName));
      const diff = await client.sendRequest('yaml-dsl/overlayDiff', {
        ...target,
        overlayNames: checkedOverlayNames,
      });
      if (!diff || requestNumber !== followRequestCount) return;
      viewsByUri.set(viewKey, { diff, target, overlayNames: stack.overlayNames, checkedOverlayNames });
      changes.fire(overlayDiffUri(vscode, stack.title));
    });
  }

  function followSelection(editor) {
    if (followTimer) timerFunctions.clearTimeout(followTimer);
    followTimer = null;
    if (!selectsInDslFile(editor) || shownViewUris().size === 0) return;
    const target = { uri: editor.document.uri.toString(), range: serializableRange(editor.selection) };
    followTimer = timerFunctions.setTimeout(() => {
      followTimer = null;
      followRequestCount += 1;
      follow(target, followRequestCount);
    }, SELECTION_FOLLOW_DELAY_MILLISECONDS);
  }

  function chooseDiffOverlays(diffUri) {
    const editor = vscode.window.activeTextEditor;
    const uri = diffUri || (editor && editor.document.uri);
    const view = uri ? viewsByUri.get(uri.toString()) : null;
    if (!view) return Promise.resolve();
    return warnOnFailure(async () => {
      const picked = await vscode.window.showQuickPick(
        view.overlayNames.map((overlayName) => ({
          label: overlayName,
          picked: view.checkedOverlayNames.includes(overlayName),
        })),
        { canPickMany: true, title: CHOOSE_DIFF_OVERLAYS_TITLE },
      );
      if (!picked || picked.length === 0) return;
      await updateView(view.target, view.overlayNames, picked.map((item) => item.label));
      paintVisible();
    });
  }

  const disposables = [
    changes,
    { dispose: () => { if (followTimer) timerFunctions.clearTimeout(followTimer); } },
    { dispose: () => { for (const colorType of colorTypes) colorType.dispose(); } },
    struckType,
    markerType,
    spacerType,
    vscode.workspace.registerTextDocumentContentProvider(OVERLAY_DIFF_SCHEME, {
      onDidChange: changes.event,
      provideTextDocumentContent(uri) {
        const view = viewsByUri.get(uri.toString());
        return view ? overlayDiffText(view.diff) : '';
      },
    }),
    vscode.commands.registerCommand(OVERLAY_DIFF_COMMAND, diffAcrossOverlays),
    vscode.commands.registerCommand(CHOOSE_DIFF_OVERLAYS_COMMAND, chooseDiffOverlays),
  ];
  return {
    diffAcrossOverlays,
    chooseDiffOverlays,
    followSelection,
    paintVisible,
    applyTheme,
    disposables,
  };
}

module.exports = {
  overlayDiffColorIds,
  OVERLAY_DIFF_SCHEME,
  createOverlayDiffViews,
  overlayDiffUri,
};

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  WAIT_DEADLINE_MILLISECONDS,
  shownDocument,
  fixtureCopy,
  positionInText,
  hoverTextBecomes,
  hoverTextHolds,
  hintLabelsBecome,
  hintTooltipOf,
  applyArgumentIn,
  undoInEditorOf,
  extensionClient,
  paintedProblemMessagesOf,
  paintedProblemMessagesBecome,
} = require('./editor-hints');
const { APPLY_COMMAND } = require('../../lib/suggestion-marks');
const { overlayHeadingOf } = require('./overlay-schema-folders');
const { isolateEachTest } = require('./test-isolation');

const FIXTURE_FOLDER = 'overlays-holding-no-documents';
const LABEL_INTEGER_PROBLEM = '`label` must be integer';
const OVERLAY_3_PROBLEM = `${LABEL_INTEGER_PROBLEM} (overlay-3)`;
const OVERLAY_LABEL_TEXT = 'mocktype:\n  shared:\n    label: 3\n';
const STRING_LABEL_HOVER = '`label`: *string*    `[optional]`\n\nMock string label.';

function stackCopy(discoveryFolder, copyLabel) {
  return fixtureCopy(path.join(FIXTURE_FOLDER, discoveryFolder), `${copyLabel}-${discoveryFolder}`);
}

async function shownCommonLayer(stack, ...segments) {
  return (await shownDocument(path.join(stack, ...segments))).document;
}

const POTENTIAL_MOVE_LABEL = 'ⓘ potential move: one difference, shared';
const OPT_OUT_TEXT = 'mocktype:\n  shared: {}\n';
const SHARED_POTENTIAL_MOVE_LABEL = 'ⓘ potential move: one difference, mock_shared';
const SHARED_OPT_OUT_TEXT = 'mocksource:\n  mock_shared: {}\n';

async function fileTextBecomes(filePath, expected) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  const textOnDisk = () => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);
  while (Date.now() < deadline && textOnDisk() !== expected) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.equal(textOnDisk(), expected);
}

async function foldTextOf(stackId, overlayName) {
  return (await extensionClient()).sendRequest('yaml-dsl/fold', { stackId, overlayName });
}

async function foldTextBecomesMatching(stackId, overlayName, pattern) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  let foldText = await foldTextOf(stackId, overlayName);
  while (Date.now() < deadline && !pattern.test(foldText)) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    foldText = await foldTextOf(stackId, overlayName);
  }
  assert.match(foldText, pattern);
  return foldText;
}

async function potentialMoveShown(stack) {
  const overlayPath = path.join(stack, 'concern-3', 'overlay-1', 'mock-dsl.yml');
  const overlay = (await shownDocument(overlayPath)).document;
  await hintLabelsBecome(overlay, [POTENTIAL_MOVE_LABEL]);
  return overlay;
}

async function potentialMoveApplied(stack, overlay) {
  const applyArgument = applyArgumentIn(await hintTooltipOf(overlay));
  await vscode.commands.executeCommand(APPLY_COMMAND, applyArgument);
  const placeDocument = path.join(stack, 'concern-3', 'overlay-3', 'mock-dsl.yml');
  await fileTextBecomes(placeDocument, OPT_OUT_TEXT);
  return placeDocument;
}

suite('overlays holding no documents', () => {
  isolateEachTest();

  test('parent: the common layer is validated through the fold '
    + 'of an overlay holding no documents', async () => {
    const stack = stackCopy('parent-discovery', 'validated');
    const common = await shownCommonLayer(stack, 'concern-1', 'mock-dsl.yml');
    await paintedProblemMessagesBecome(common, [OVERLAY_3_PROBLEM]);
  });

  test('ancestor: a concern\'s common layer is validated through the fold '
    + 'of an overlay holding no documents', async () => {
    const stack = stackCopy('ancestor-discovery', 'validated');
    const common = await shownCommonLayer(stack, 'concern-group', 'concern-1.mock-dsl.yml');
    await paintedProblemMessagesBecome(common, [OVERLAY_3_PROBLEM]);
  });

  test('parent: a common layer with no overlay file in any overlay directory '
    + 'is validated alone', async () => {
    const stack = stackCopy('parent-discovery', 'alone');
    const common = await shownCommonLayer(stack, 'concern-2', 'mock-dsl.yml');
    await paintedProblemMessagesBecome(common, [LABEL_INTEGER_PROBLEM]);
  });

  test('ancestor: a common layer with no overlay file in any overlay directory '
    + 'is validated alone', async () => {
    const stack = stackCopy('ancestor-discovery', 'alone');
    const common = await shownCommonLayer(stack, 'lone-group', 'mock-dsl.yml');
    await paintedProblemMessagesBecome(common, [LABEL_INTEGER_PROBLEM]);
  });

  test('an overlay directory appearing makes an overlay holding no documents '
    + 'of the stack', async () => {
    const stack = stackCopy('parent-discovery', 'appearing');
    const placeFolder = path.join(stack, 'concern-1', 'overlay-3');
    fs.renameSync(placeFolder, `${placeFolder}-away`);
    const common = await shownCommonLayer(stack, 'concern-1', 'mock-dsl.yml');
    await hoverTextBecomes(common, positionInText(common, 'label'), STRING_LABEL_HOVER);
    assert.deepEqual(await paintedProblemMessagesOf(common), []);
    fs.renameSync(`${placeFolder}-away`, placeFolder);
    await paintedProblemMessagesBecome(common, [OVERLAY_3_PROBLEM]);
  });

  test('an overlay directory going leaves the stack', async () => {
    const stack = stackCopy('parent-discovery', 'going');
    const placeFolder = path.join(stack, 'concern-1', 'overlay-3');
    const common = await shownCommonLayer(stack, 'concern-1', 'mock-dsl.yml');
    await paintedProblemMessagesBecome(common, [OVERLAY_3_PROBLEM]);
    fs.renameSync(placeFolder, `${placeFolder}-away`);
    await paintedProblemMessagesBecome(common, []);
  });

  test('an overlay file created in an overlay holding no documents '
    + 'is folded with the common layer', async () => {
    const stack = stackCopy('parent-discovery', 'created');
    const common = await shownCommonLayer(stack, 'concern-1', 'mock-dsl.yml');
    await paintedProblemMessagesBecome(common, [OVERLAY_3_PROBLEM]);
    const placeDocument = path.join(stack, 'concern-1', 'overlay-3', 'mock-dsl.yml');
    fs.writeFileSync(placeDocument, OVERLAY_LABEL_TEXT);
    await paintedProblemMessagesBecome(common, []);
  });

  test('an overlay file moved out of its directory '
    + 'leaves an overlay holding no documents', async () => {
    const stack = stackCopy('parent-discovery', 'moved-out');
    const overlayFile = path.join(stack, 'concern-1', 'overlay-3', 'mock-dsl.yml');
    fs.writeFileSync(overlayFile, OVERLAY_LABEL_TEXT);
    const common = await shownCommonLayer(stack, 'concern-1', 'mock-dsl.yml');
    await hoverTextHolds(common, positionInText(common, 'label'), overlayHeadingOf('overlay-3'));
    assert.deepEqual(await paintedProblemMessagesOf(common), []);
    fs.renameSync(overlayFile, path.join(stack, 'concern-1', 'mock-dsl.yml.away'));
    await paintedProblemMessagesBecome(common, [OVERLAY_3_PROBLEM]);
  });

  test('a potential move\'s click creates the document of an overlay holding no documents '
    + 'holding the opt-out, and that overlay\'s fold gains nothing', async () => {
    const stack = stackCopy('parent-discovery', 'opted-out');
    const stackId = path.join(stack, 'concern-3', 'mock-dsl.yml');
    const overlay = await potentialMoveShown(stack);
    assert.match(await foldTextOf(stackId, 'overlay-3'), /other: mock-other/);
    assert.doesNotMatch(await foldTextOf(stackId, 'overlay-3'), /size/);
    await potentialMoveApplied(stack, overlay);
    await fileTextBecomes(stackId, 'mocktype:\n  shared:\n    size: 1\nother: mock-other\n');
    const foldAfter = await foldTextBecomesMatching(stackId, 'overlay-3', /shared: \{\}/);
    assert.match(foldAfter, /mocktype:\n {2}shared: \{\}\nother: mock-other/);
    assert.doesNotMatch(foldAfter, /size/);
  });

  test('ancestor: a unit the two overlays holding documents hold alike '
    + 'is shown as a potential move while two overlays hold no documents', async () => {
    const stack = stackCopy('ancestor-two-documents', 'shown');
    const overlayPath = path.join(stack, 'concern-1', 'overlay-1', 'mock-dsl.yml');
    const overlay = (await shownDocument(overlayPath)).document;
    await hintLabelsBecome(overlay, [SHARED_POTENTIAL_MOVE_LABEL]);
  });

  test('ancestor: that potential move\'s click creates each overlay\'s document '
    + 'holding the opt-out, and their folds gain nothing', async () => {
    const stack = stackCopy('ancestor-two-documents', 'clicked');
    const stackId = path.join(stack, 'concern-1', 'mock-dsl.yml');
    const overlayPath = path.join(stack, 'concern-1', 'overlay-1', 'mock-dsl.yml');
    const overlay = (await shownDocument(overlayPath)).document;
    await hintLabelsBecome(overlay, [SHARED_POTENTIAL_MOVE_LABEL]);
    const applyArgument = applyArgumentIn(await hintTooltipOf(overlay));
    await vscode.commands.executeCommand(APPLY_COMMAND, applyArgument);
    for (const overlayName of ['overlay-3', 'overlay-4']) {
      const placeDocument = path.join(stack, 'concern-1', overlayName, 'mock-dsl.yml');
      await fileTextBecomes(placeDocument, SHARED_OPT_OUT_TEXT);
      const foldAfter = await foldTextBecomesMatching(stackId, overlayName, /mock_shared: \{\}/);
      assert.doesNotMatch(foldAfter, /key_id/);
    }
  });

  test('undoing that click removes the created document', async () => {
    const stack = stackCopy('parent-discovery', 'undone');
    const overlay = await potentialMoveShown(stack);
    const placeDocument = await potentialMoveApplied(stack, overlay);
    await fileTextBecomes(overlay.uri.fsPath, '');
    await undoInEditorOf(overlay);
    await fileTextBecomes(placeDocument, null);
  });
});

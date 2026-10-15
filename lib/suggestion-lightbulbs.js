const YAML = require('yaml');
const { flowValueText } = require('./flow-value-text');
const { explorerDecoration } = require('./explorer-folders');
const { textHashOf } = require('./text-hash');

const APPLY_COMMAND = 'yaml-dsl-editor.applySuggestion';
const HIDE_HOVER_COMMAND = 'editor.action.hideHover';
const REVERT_FILE_COMMAND = 'workbench.action.files.revert';
const RENAME_PROVIDER_COMMAND = 'vscode.executeDocumentRenameProvider';
const LIGHTBULB_THEME_COLOR = 'editorLightBulb.foreground';
const LIGHTBULB_BADGE = '💡';

function codeSpan(text) {
  return `\`${String(text).replaceAll('`', "'")}\``;
}

function shownValueText(text) {
  let value;
  try {
    value = YAML.parse(text);
  } catch {
    return text;
  }
  return value !== null && typeof value === 'object' ? flowValueText(value) : text;
}

function differenceLines(differences) {
  if (differences.length === 0) return [];
  const heading = differences.length === 1
    ? '1 difference becomes a local:'
    : `${differences.length} differences become locals:`;
  return [
    heading,
    '',
    ...differences.map((difference) => {
      const values = difference.values
        .map((value) => `${codeSpan(shownValueText(value.text))} (${value.overlays.join(', ')})`);
      return `- ${codeSpan(difference.name)}: ${values.join(', ')}`;
    }),
    '',
  ];
}

function applyArgument(suggestion) {
  const declaredAt = suggestion.kind === 'rename' && suggestion.rename ? suggestion.rename.declaredAt : undefined;
  return declaredAt
    ? { stackId: suggestion.stackId, id: suggestion.id, declaredAt }
    : { stackId: suggestion.stackId, id: suggestion.id };
}

const SCHEMA_GROUP_DETAILS = {
  no_schema: 'it has no schema',
  not_allowed: 'its schema does not allow it',
};

function schemaGroupLine(group) {
  const detail = SCHEMA_GROUP_DETAILS[group.state];
  return `- ${group.overlays.join(', ')}${detail ? `: ${detail}` : ''}`;
}

const MARKDOWN_HARD_BREAK = '\\';

function failureTexts(failure) {
  if (failure.kind !== 'alternatives') return [failure.text];
  const choices = failure.alternatives
    .map((alternative, index) => `(${index + 1}) ${alternative.flatMap(failureTexts).join('; ')}`);
  return [`one of: ${choices.join(' ')}`];
}

function alternativeLines(alternative, index, indent) {
  const number = `${index + 1}. `;
  const texts = alternative.flatMap(failureTexts);
  return texts.map((text, line) => {
    const lead = line === 0 ? number : ' '.repeat(number.length);
    const lineBreak = line < texts.length - 1 ? MARKDOWN_HARD_BREAK : '';
    return `${indent}${lead}${text}${lineBreak}`;
  });
}

function failureLines(failure, block, indent) {
  if (failure.kind !== 'alternatives') return [`${indent}- ${block}: ${failure.text}`];
  return [
    `${indent}- ${block} matches none of these alternatives:`,
    ...failure.alternatives.flatMap((alternative, index) => alternativeLines(alternative, index, `${indent}  `)),
  ];
}

function potentialMoveLines(suggestion, block, share) {
  if (suggestion.schemaGroups.length > 0) {
    return [
      `${block} is common to ${share}, but its schema differs between overlays:`,
      '',
      ...suggestion.schemaGroups.map(schemaGroupLine),
      '',
      "Make the overlays' schemas agree on it to move it to the common layer.",
    ];
  }
  const optOutText = suggestion.optOutFailures.length > 0 ? suggestion.optOutFailures[0].valueText : '{}';
  return [
    `${block} is common to ${share}, but the ${codeSpan(optOutText)} opt-out would fail the schema in:`,
    '',
    ...suggestion.optOutFailures.flatMap((optOut) => [
      `- ${optOut.overlay}`,
      ...optOut.failures.flatMap((failure) => failureLines(failure, block, '  ')),
    ]),
  ];
}

function unitOptOutsByValue(suggestion) {
  const overlaysByValue = new Map();
  for (const optOut of suggestion.optOuts.filter((candidate) => candidate.relativePath.length === 0)) {
    if (!overlaysByValue.has(optOut.valueText)) overlaysByValue.set(optOut.valueText, []);
    overlaysByValue.get(optOut.valueText).push(optOut.overlay);
  }
  return overlaysByValue;
}

function moveLinkText(suggestion) {
  if (!suggestion.commonLayerFile) return 'Move to common layer';
  const fileText = suggestion.commonLayerFile.replace(/[\\`*_[\]]/g, '\\$&');
  return `Move to common layer (${suggestion.createsCommonLayer ? 'new ' : ''}${fileText})`;
}

function hoverMarkdownText(suggestion) {
  const block = codeSpan(suggestion.path.join('.'));
  const link = `command:${APPLY_COMMAND}?${encodeURIComponent(JSON.stringify(applyArgument(suggestion)))}`;
  if (suggestion.kind === 'potential_move') {
    return potentialMoveLines(suggestion, block, `${suggestion.holders.length} of ${suggestion.overlayCount} overlays`)
      .join('\n');
  }
  if (suggestion.kind === 'delete') {
    return [
      `${block} in ${suggestion.holders.join(', ')} is the same as in the common layer. Delete it.`,
      '',
      `[Delete it](${link})`,
    ].join('\n');
  }
  if (suggestion.kind === 'rename') {
    const { oldName, newName, files } = suggestion.rename;
    return [
      `${codeSpan(oldName)} is renamed ${codeSpan(newName)} here. Renaming it everywhere changes:`,
      '',
      ...files.map((file) => `- ${file.label}: ${file.count} ${file.count === 1 ? 'place' : 'places'}`),
      '',
      `[Rename everywhere](${link})`,
    ].join('\n');
  }
  const share = `${suggestion.holders.length} of ${suggestion.overlayCount} overlays`;
  if (suggestion.optOutConditionalFields.length > 0) {
    return [
      `${block} is common to ${share}, but the ${codeSpan('{}')} opt-out leaves out a conditionally required field in:`,
      '',
      ...suggestion.optOutConditionalFields.flatMap((conditional) => [
        `- ${conditional.overlay}`,
        ...conditional.fields.map((field) => `  - ${codeSpan(field)} is [~required]`),
      ]),
      '',
      'The extension cannot tell whether the move is safe.',
      '',
      ...differenceLines(suggestion.differences),
      `[${moveLinkText(suggestion)}](${link})`,
    ].join('\n');
  }
  const memberPaths = suggestion.memberPaths || [];
  const opening = memberPaths.length > 1
    ? [
      `These blocks are common to ${share}. Move them to the common layer:`,
      '',
      ...memberPaths.map((memberPath) => `- ${codeSpan(memberPath.join('.'))}`),
    ]
    : [`${block} is common to ${share}. Move it to the common layer.`];
  const differenceNote = suggestion.differencePaths.length > 0
    ? ['', 'Moving it writes one difference into the overlays, so the choice is yours.']
    : [];
  const lines = [...opening, ...differenceNote, '', ...differenceLines(suggestion.differences)];
  for (const [optOutText, overlays] of unitOptOutsByValue(suggestion)) {
    lines.push(`Opts out with ${codeSpan(optOutText)}: ${overlays.join(', ')}`, '');
  }
  if (suggestion.keepsCommonValue.length > 0) {
    lines.push(`Keeps the common layer's current value: ${suggestion.keepsCommonValue.join(', ')}`, '');
  }
  if (suggestion.keepsOwnValue.length > 0) lines.push(`Keeps its own value: ${suggestion.keepsOwnValue.join(', ')}`, '');
  lines.push(`[${moveLinkText(suggestion)}](${link})`);
  return lines.join('\n');
}

function hoverMarkdown(vscode, suggestion) {
  const markdown = new vscode.MarkdownString(hoverMarkdownText(suggestion));
  markdown.isTrusted = { enabledCommands: [APPLY_COMMAND] };
  return markdown;
}

function isPotentialMove(suggestion) {
  return suggestion.kind === 'potential_move'
    || (suggestion.kind === 'move' && suggestion.optOutConditionalFields.length > 0)
    || (suggestion.kind === 'move' && suggestion.differencePaths.length > 0);
}

function suggestionKindOf(suggestion) {
  return isPotentialMove(suggestion) ? 'potentialMove' : suggestion.kind;
}

function differenceLabelOf(suggestion) {
  const [differencePath] = suggestion.differencePaths;
  let shared = 0;
  while (shared < suggestion.path.length && differencePath[shared] === suggestion.path[shared]) shared += 1;
  const relativePath = differencePath.slice(shared);
  return relativePath.length > 0 ? relativePath.join('.') : differencePath[differencePath.length - 1];
}

function gutterRanges(vscode, marks) {
  return marks.map((mark) => new vscode.Range(
    mark.range.start.line,
    mark.range.start.character,
    mark.range.end.line,
    mark.range.end.character,
  ));
}

function paintLightbulbs(vscode, gutterMarks, marksByUri) {
  for (const editor of (vscode.window && vscode.window.visibleTextEditors) || []) {
    if (!editor || !editor.document || !editor.document.uri || !editor.setDecorations) continue;
    const marks = marksByUri.get(editor.document.uri.toString()) || [];
    const potentialMoves = marks.filter((mark) => isPotentialMove(mark.suggestion));
    const certainMoves = marks.filter((mark) => !potentialMoves.includes(mark));
    editor.setDecorations(gutterMarks.lightbulb, gutterRanges(vscode, certainMoves));
    editor.setDecorations(gutterMarks.potentialMove, gutterRanges(vscode, potentialMoves));
  }
}

const SCOPE_BORDER_WIDTHS = {
  top: '1px 1px 0 1px',
  middle: '0 1px 0 1px',
  bottom: '0 1px 1px 1px',
  single: '1px',
};

function scopeBorderRanges(vscode, marks) {
  const ranges = { top: [], middle: [], bottom: [], single: [] };
  for (const mark of marks) {
    const firstLine = mark.scope.start.line;
    const lastLine = mark.scope.end.line;
    if (firstLine === lastLine) {
      ranges.single.push(new vscode.Range(firstLine, 0, firstLine, 0));
      continue;
    }
    ranges.top.push(new vscode.Range(firstLine, 0, firstLine, 0));
    if (lastLine - firstLine > 1) ranges.middle.push(new vscode.Range(firstLine + 1, 0, lastLine - 1, 0));
    ranges.bottom.push(new vscode.Range(lastLine, 0, lastLine, 0));
  }
  return ranges;
}

function paintScopeBorders(vscode, scopeBorders, marksByUri) {
  for (const editor of (vscode.window && vscode.window.visibleTextEditors) || []) {
    if (!editor || !editor.document || !editor.document.uri || !editor.setDecorations) continue;
    const cursorLine = editor.selection ? editor.selection.active.line : null;
    const marks = (marksByUri.get(editor.document.uri.toString()) || [])
      .filter((mark) => mark.scope && mark.range.start.line === cursorLine);
    const families = {
      lightbulb: marks.filter((mark) => !isPotentialMove(mark.suggestion)),
      potentialMove: marks.filter((mark) => isPotentialMove(mark.suggestion)),
    };
    for (const [family, familyMarks] of Object.entries(families)) {
      const ranges = scopeBorderRanges(vscode, familyMarks);
      for (const part of Object.keys(SCOPE_BORDER_WIDTHS)) {
        editor.setDecorations(scopeBorders[family][part], ranges[part]);
      }
    }
  }
}

function inlayLabelText(suggestion) {
  if (suggestion.kind === 'delete') return '💡 same in common layer';
  if (suggestion.kind === 'rename') {
    return `💡 rename everywhere: ${suggestion.rename.oldName} → ${suggestion.rename.newName}`;
  }
  if (suggestion.optOutConditionalFields.length > 0) {
    const overlays = suggestion.optOutConditionalFields.map((conditional) => conditional.overlay).join(', ');
    return `ⓘ potential move: overlay (${overlays}) opt-out leaves out a conditionally required field`;
  }
  if (suggestion.kind === 'move' && suggestion.differencePaths.length > 0) {
    return `ⓘ potential move: one difference, ${differenceLabelOf(suggestion)}`;
  }
  if (suggestion.kind !== 'potential_move') {
    const memberPaths = suggestion.memberPaths || [];
    if (memberPaths.length < 2) return '💡 move to common layer';
    return `💡 move to common layer: ${memberPaths.map((memberPath) => memberPath[memberPath.length - 1]).join(', ')}`;
  }
  if (suggestion.schemaGroups.length > 0) return 'ⓘ potential move: overlay schemas differ';
  const overlays = suggestion.optOutFailures.map((failure) => failure.overlay).join(', ');
  return `ⓘ potential move: overlay (${overlays}) opt-out would fail the schema`;
}

function suggestionInlayHints(vscode, marksByUri, document) {
  const marks = marksByUri.get(document.uri.toString()) || [];
  return marks
    .filter((mark) => mark.range.start.line < document.lineCount)
    .map((mark) => {
      const label = new vscode.InlayHintLabelPart(inlayLabelText(mark.suggestion));
      label.tooltip = hoverMarkdown(vscode, mark.suggestion);
      const hint = new vscode.InlayHint(document.lineAt(mark.range.start.line).range.end, [label]);
      hint.paddingLeft = true;
      return hint;
    });
}

function suggestionFileUrisOf(marksByUri) {
  return [...marksByUri]
    .filter(([, marks]) => marks.some((mark) => !isPotentialMove(mark.suggestion)))
    .map(([fileUri]) => fileUri);
}

function suggestionFileDecoration(vscode, suggestionUriSets, uri) {
  return explorerDecoration(vscode, {
    badge: LIGHTBULB_BADGE,
    themeColor: LIGHTBULB_THEME_COLOR,
    uriSets: suggestionUriSets,
    uri,
  });
}

async function saveEditedFiles(vscode, uris) {
  const unsaved = [];
  for (const uri of uris) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    if (document.isDirty && !(await document.save())) unsaved.push(uri);
  }
  if (unsaved.length === 0) return;
  vscode.window.showWarningMessage(`the suggestion left these files unsaved: ${unsaved.join(', ')}`);
}

async function dismissHover(vscode) {
  try {
    await vscode.commands.executeCommand(HIDE_HOVER_COMMAND);
  } catch {
    // No hover to dismiss.
  }
}

function editorPositionOf(vscode, position) {
  return new vscode.Position(position.line, position.character);
}

async function textHashesOf(vscode, uris) {
  const hashes = new Map();
  for (const uri of uris) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    hashes.set(uri, textHashOf(document.getText()));
  }
  return hashes;
}

async function handRenameUndone(vscode, editor, declaredAt, writtenNewRange) {
  if (editor.document.isDirty) {
    await vscode.commands.executeCommand(REVERT_FILE_COMMAND);
    return;
  }
  await editor.edit((builder) => builder.replace(writtenNewRange, declaredAt.oldWrittenName));
  await saveEditedFiles(vscode, [editor.document.uri.toString()]);
}

async function renamedFromHandRenameUndone(vscode, declaredAt, undoSaves) {
  const editor = vscode.window.activeTextEditor;
  const document = editor && editor.document;
  if (!document || document.uri.toString() !== declaredAt.uri || !declaredAt.oldWrittenName) return false;
  const start = editorPositionOf(vscode, declaredAt.range.start);
  const writtenNewRange = new vscode.Range(start, editorPositionOf(vscode, declaredAt.range.end));
  const writtenNewName = document.getText(writtenNewRange);
  await handRenameUndone(vscode, editor, declaredAt, writtenNewRange);
  let edit = null;
  let refusal = 'the rename has no edit';
  try {
    edit = await vscode.commands.executeCommand(RENAME_PROVIDER_COMMAND, document.uri, start, writtenNewName);
  } catch (error) {
    refusal = error.message;
  }
  if (!edit || edit.size === 0) {
    const oldWrittenRange = new vscode.Range(start, start.translate(0, declaredAt.oldWrittenName.length));
    await editor.edit((builder) => builder.replace(oldWrittenRange, writtenNewName));
    vscode.window.showWarningMessage(refusal);
    return true;
  }
  const uris = edit.entries().map(([uri]) => uri.toString());
  const hashesBefore = await textHashesOf(vscode, uris);
  await vscode.workspace.applyEdit(edit);
  const hashesAfter = await textHashesOf(vscode, uris);
  undoSaves.recordApply(uris.map((uri) => ({
    uri,
    textHashBefore: hashesBefore.get(uri),
    textHashAfter: hashesAfter.get(uri),
    fileCreated: false,
  })));
  await saveEditedFiles(vscode, uris);
  return true;
}

async function applySuggestion(vscode, client, argument, undoSaves) {
  if (!argument || !argument.stackId || typeof argument.id !== 'string') return;
  await dismissHover(vscode);
  if (argument.declaredAt && await renamedFromHandRenameUndone(vscode, argument.declaredAt, undoSaves)) return;
  let answer = null;
  try {
    answer = await client.sendRequest('yaml-dsl/applySuggestion', argument);
  } catch (error) {
    answer = { applied: false, message: error.message };
  }
  if (answer && !answer.applied && answer.message) vscode.window.showWarningMessage(answer.message);
  if (!answer || !answer.applied) return;
  const files = answer.files || [];
  undoSaves.recordApply(files);
  await saveEditedFiles(vscode, files.map((file) => file.uri));
}

module.exports = {
  APPLY_COMMAND,
  LIGHTBULB_THEME_COLOR,
  SCOPE_BORDER_WIDTHS,
  hoverMarkdownText,
  paintLightbulbs,
  paintScopeBorders,
  suggestionInlayHints,
  suggestionFileDecoration,
  suggestionFileUrisOf,
  suggestionKindOf,
  applySuggestion,
};

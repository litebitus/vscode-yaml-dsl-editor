const APPLY_COMMAND = 'yaml-dsl-editor.applySuggestion';
const HIDE_HOVER_COMMAND = 'editor.action.hideHover';
const LIGHTBULB_THEME_COLOR = 'editorLightBulb.foreground';
const LIGHTBULB_BADGE = '💡';

function codeSpan(text) {
  return `\`${String(text).replaceAll('`', "'")}\``;
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
      const values = difference.values.map((value) => `${codeSpan(value.text)} (${value.overlays.join(', ')})`);
      return `- ${codeSpan(difference.name)}: ${values.join(', ')}`;
    }),
    '',
  ];
}

function applyArgument(suggestion) {
  return { stackId: suggestion.stackId, id: suggestion.id };
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
  return [
    `${block} is common to ${share}, but the ${codeSpan('{}')} opt-out would fail the schema in:`,
    '',
    ...suggestion.optOutFailures.flatMap((optOut) => [
      `- ${optOut.overlay}`,
      ...optOut.failures.flatMap((failure) => failureLines(failure, block, '  ')),
    ]),
  ];
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
      `[Move to common layer](${link})`,
    ].join('\n');
  }
  const lines = [
    `${block} is common to ${share}. Move it to the common layer.`,
    '',
    ...differenceLines(suggestion.differences),
  ];
  if (suggestion.absent.length > 0) lines.push(`Opts out with ${codeSpan('{}')}: ${suggestion.absent.join(', ')}`, '');
  if (suggestion.keepsCommonValue.length > 0) {
    lines.push(`Keeps the common layer's current value: ${suggestion.keepsCommonValue.join(', ')}`, '');
  }
  if (suggestion.keepsOwnValue.length > 0) lines.push(`Keeps its own value: ${suggestion.keepsOwnValue.join(', ')}`, '');
  if (suggestion.createsCommonLayer) lines.push('Creates the common layer file.', '');
  lines.push(`[Move to common layer](${link})`);
  return lines.join('\n');
}

function hoverMarkdown(vscode, suggestion) {
  const markdown = new vscode.MarkdownString(hoverMarkdownText(suggestion));
  markdown.isTrusted = { enabledCommands: [APPLY_COMMAND] };
  return markdown;
}

function isPotentialMove(suggestion) {
  return suggestion.kind === 'potential_move'
    || (suggestion.kind === 'move' && suggestion.optOutConditionalFields.length > 0);
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
    editor.setDecorations(gutterMarks.lightbulb, gutterRanges(vscode, marks.filter((mark) => !potentialMoves.includes(mark))));
    editor.setDecorations(gutterMarks.potentialMove, gutterRanges(vscode, potentialMoves));
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
  if (suggestion.kind !== 'potential_move') return '💡 move to common layer';
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

function suggestionFileDecoration(vscode, marksByUri, uri) {
  const marks = (marksByUri.get(uri.toString()) || []).filter((mark) => !isPotentialMove(mark.suggestion));
  if (marks.length === 0) return undefined;
  const decoration = new vscode.FileDecoration(
    LIGHTBULB_BADGE,
    undefined,
    new vscode.ThemeColor(LIGHTBULB_THEME_COLOR),
  );
  decoration.propagate = true;
  return decoration;
}

async function saveEditedFiles(vscode, uris) {
  const unsaved = [];
  for (const uri of uris) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    if (!(await document.save())) unsaved.push(uri);
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

async function applySuggestion(vscode, client, argument, undoSaves) {
  if (!argument || !argument.stackId || typeof argument.id !== 'string') return;
  await dismissHover(vscode);
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
  hoverMarkdownText,
  paintLightbulbs,
  suggestionInlayHints,
  suggestionFileDecoration,
  applySuggestion,
};

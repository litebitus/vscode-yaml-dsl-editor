const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  fixtureCopy,
  positionInText,
  hoverTextBecomes,
  schemaTextOf,
} = require('./editor-hints');
const {
  SCHEMA_FOLDER,
  SCHEMA_FILE,
  labelSchemaText,
  writeSchemaFolder,
  writeOverlays,
  overlayHeadingOf,
} = require('./overlay-schema-folders');
const { isolateEachTest } = require('./test-isolation');

const UNREPORTED_STACK_LABEL = 'unreported-schema';

async function withUnreportedSchemaChanges(body) {
  const ideSettings = vscode.workspace.getConfiguration();
  const editorSettings = vscode.workspace.getConfiguration('yaml-dsl-editor');
  const hidden = { [`**/${UNREPORTED_STACK_LABEL}-copy-*/**`]: true };
  await ideSettings.update('files.watcherExclude', hidden, vscode.ConfigurationTarget.Global);
  await editorSettings.update('cache.diskCheckSeconds', 1, vscode.ConfigurationTarget.Global);
  try {
    await body();
  } finally {
    await editorSettings.update('cache.diskCheckSeconds', undefined, vscode.ConfigurationTarget.Global);
    await ideSettings.update('files.watcherExclude', undefined, vscode.ConfigurationTarget.Global);
  }
}

function replaceSchemaFolder(overlayFolder, labelDescription) {
  const schemaFolder = path.join(overlayFolder, SCHEMA_FOLDER);
  fs.renameSync(schemaFolder, `${schemaFolder}-previous`);
  writeSchemaFolder(overlayFolder, labelDescription);
}

suite('schema reload', () => {
  isolateEachTest();

  test('an overlay schema whose folder is replaced, as initializing a stack again does, is read again', async () => {
    const stack = fixtureCopy('stack', 'reinitialized-schema');
    writeOverlays(stack, { one: 'Label of one first', two: 'Label of two first' });
    await shownDocument(path.join(stack, 'mock.yml'));
    const overlay = (await shownDocument(path.join(stack, 'two', 'mock.yml'))).document;
    const label = positionInText(overlay, 'label: mock', 1);
    const documentationOf = (description) => `\`label\`: *string*    \`[optional]\`\n\n${schemaTextOf(description)}`;
    await hoverTextBecomes(overlay, label, documentationOf('Label of two first'));
    replaceSchemaFolder(path.join(stack, 'two'), 'Label of two second');
    await hoverTextBecomes(overlay, label, documentationOf('Label of two second'));
  });

  test('a schema change the IDE does not report is read again at the next disk check', async () => {
    await withUnreportedSchemaChanges(async () => {
      const stack = fixtureCopy('stack', UNREPORTED_STACK_LABEL);
      writeOverlays(stack, { one: 'Label of one first', two: 'Label of two first' });
      const overlay = (await shownDocument(path.join(stack, 'two', 'mock.yml'))).document;
      const label = positionInText(overlay, 'label: mock', 1);
      const documentationOf = (description) => `\`label\`: *string*    \`[optional]\`\n\n${schemaTextOf(description)}`;
      await hoverTextBecomes(overlay, label, documentationOf('Label of two first'));
      fs.writeFileSync(path.join(stack, 'two', SCHEMA_FOLDER, SCHEMA_FILE), labelSchemaText('Label of two second'));
      await hoverTextBecomes(overlay, label, documentationOf('Label of two second'));
    });
  });

  test('a common layer field hover shows each overlay schema\'s documentation when the overlays\' schemas differ', async () => {
    const stack = fixtureCopy('stack', 'differing-overlay-schemas');
    writeOverlays(stack, { one: 'Label of one first', two: 'Label of two first' });
    fs.writeFileSync(path.join(stack, 'mock.yml'), 'mocktype:\n  shared:\n    label: mock\n');
    const common = (await shownDocument(path.join(stack, 'mock.yml'))).document;
    const sectionOf = (overlayName, description) => (
      `${overlayHeadingOf(overlayName)}\n\n\`label\`: *string*    \`[optional]\`\n\n${schemaTextOf(description)}`
    );
    const label = positionInText(common, 'label: mock', 1);
    await hoverTextBecomes(
      common,
      label,
      [sectionOf('one', 'Label of one first'), sectionOf('two', 'Label of two first')].join('\n\n'),
    );
    replaceSchemaFolder(path.join(stack, 'two'), 'Label of one first');
    await hoverTextBecomes(common, label, `\`label\`: *string*    \`[optional]\`\n\n${schemaTextOf('Label of one first')}`);
  });

  test('a common layer field hover names the overlays whose schema has no such field', async () => {
    const stack = fixtureCopy('stack', 'overlay-schema-without-field');
    writeOverlays(stack, { one: 'Label of one', two: 'Label of one' });
    const closedSchema = JSON.parse(labelSchemaText('Label of two'));
    closedSchema.properties.mocktype.additionalProperties = { type: 'object', additionalProperties: false };
    fs.writeFileSync(
      path.join(stack, 'two', SCHEMA_FOLDER, SCHEMA_FILE),
      JSON.stringify(closedSchema),
    );
    fs.writeFileSync(path.join(stack, 'mock.yml'), 'mocktype:\n  shared:\n    label: mock\n');
    const common = (await shownDocument(path.join(stack, 'mock.yml'))).document;
    await hoverTextBecomes(
      common,
      positionInText(common, 'label: mock', 1),
      [
        `${overlayHeadingOf('one')}\n\n\`label\`: *string*    \`[optional]\`\n\n${schemaTextOf('Label of one')}`,
        `${overlayHeadingOf('two')}\n\nnot a field`,
      ].join('\n\n'),
    );
  });
});

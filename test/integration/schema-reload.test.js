const fs = require('fs');
const path = require('path');
const { shownDocument, fixtureCopy, positionInText, hoverTextBecomes } = require('./editor-hints');
const {
  SCHEMA_FOLDER,
  SCHEMA_FILE,
  labelSchemaText,
  writeSchemaFolder,
  writeOverlays,
  overlayHeadingOf,
} = require('./overlay-schema-folders');
const { isolateEachTest } = require('./test-isolation');

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
    const documentationOf = (description) => `\`\`\`\nlabel: string    [optional]\n\`\`\`\n\n${description}`;
    await hoverTextBecomes(overlay, label, documentationOf('Label of two first'));
    replaceSchemaFolder(path.join(stack, 'two'), 'Label of two second');
    await hoverTextBecomes(overlay, label, documentationOf('Label of two second'));
  });

  test('a common layer field hover shows each overlay schema\'s documentation when the overlays\' schemas differ', async () => {
    const stack = fixtureCopy('stack', 'differing-overlay-schemas');
    writeOverlays(stack, { one: 'Label of one first', two: 'Label of two first' });
    fs.writeFileSync(path.join(stack, 'mock.yml'), 'mocktype:\n  shared:\n    label: mock\n');
    const common = (await shownDocument(path.join(stack, 'mock.yml'))).document;
    const sectionOf = (overlayName, description) => (
      `${overlayHeadingOf(overlayName)}\n\n\`\`\`\nlabel: string    [optional]\n\`\`\`\n\n${description}`
    );
    const label = positionInText(common, 'label: mock', 1);
    await hoverTextBecomes(
      common,
      label,
      [sectionOf('one', 'Label of one first'), sectionOf('two', 'Label of two first')].join('\n\n'),
    );
    replaceSchemaFolder(path.join(stack, 'two'), 'Label of one first');
    await hoverTextBecomes(common, label, '```\nlabel: string    [optional]\n```\n\nLabel of one first');
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
        `${overlayHeadingOf('one')}\n\n\`\`\`\nlabel: string    [optional]\n\`\`\`\n\nLabel of one`,
        `${overlayHeadingOf('two')}\n\nnot a field`,
      ].join('\n\n'),
    );
  });
});

const fs = require('fs');
const path = require('path');
const { shownDocument, fixtureCopy, positionInText, hoverTextBecomes } = require('./editor-hints');

const SCHEMA_FOLDER = path.join('.terraform', 'modules', 'resources_yaml');
const MODELINE = `# yaml-language-server: $schema=${SCHEMA_FOLDER.split(path.sep).join('/')}/resources.schema.json\n`;

function labelSchemaText(labelDescription) {
  return JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      mocktype: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { label: { type: 'string', description: labelDescription } },
        },
      },
    },
  });
}

function writeSchemaFolder(overlayFolder, labelDescription) {
  const schemaFolder = path.join(overlayFolder, SCHEMA_FOLDER);
  fs.mkdirSync(schemaFolder, { recursive: true });
  fs.writeFileSync(path.join(schemaFolder, 'resources.schema.json'), labelSchemaText(labelDescription));
}

function overlayHeadingOf(labels) {
  return `<span style="color:var(--vscode-yamlDslEditor-overlayHeadingForeground);"><strong>${labels}</strong></span>`;
}

function replaceSchemaFolder(overlayFolder, labelDescription) {
  const schemaFolder = path.join(overlayFolder, SCHEMA_FOLDER);
  fs.renameSync(schemaFolder, `${schemaFolder}-previous`);
  writeSchemaFolder(overlayFolder, labelDescription);
}

suite('schema reload', () => {
  test('an overlay schema whose folder is replaced, as initializing a stack again does, is read again', async () => {
    const stack = fixtureCopy('stack', 'reinitialized-schema');
    for (const [overlayName, version] of [['one', 'one first'], ['two', 'two first']]) {
      const overlayFolder = path.join(stack, overlayName);
      fs.mkdirSync(overlayFolder, { recursive: true });
      fs.writeFileSync(path.join(overlayFolder, 'mock.yml'), `${MODELINE}mocktype:\n  replica:\n    label: mock\n`);
      writeSchemaFolder(overlayFolder, `Label of ${version}`);
    }
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
    for (const [overlayName, version] of [['one', 'one first'], ['two', 'two first']]) {
      const overlayFolder = path.join(stack, overlayName);
      fs.mkdirSync(overlayFolder, { recursive: true });
      fs.writeFileSync(path.join(overlayFolder, 'mock.yml'), `${MODELINE}mocktype:\n  replica:\n    label: mock\n`);
      writeSchemaFolder(overlayFolder, `Label of ${version}`);
    }
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
    for (const overlayName of ['one', 'two']) {
      const overlayFolder = path.join(stack, overlayName);
      fs.mkdirSync(overlayFolder, { recursive: true });
      fs.writeFileSync(path.join(overlayFolder, 'mock.yml'), `${MODELINE}mocktype:\n  replica:\n    label: mock\n`);
      writeSchemaFolder(overlayFolder, 'Label of one');
    }
    const closedSchema = JSON.parse(labelSchemaText('Label of two'));
    closedSchema.properties.mocktype.additionalProperties = { type: 'object', additionalProperties: false };
    fs.writeFileSync(
      path.join(stack, 'two', SCHEMA_FOLDER, 'resources.schema.json'),
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

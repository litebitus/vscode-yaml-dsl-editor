const fs = require('fs');
const path = require('path');

const SCHEMA_FOLDER = path.join('.schema', 'sample');
const SCHEMA_FILE = 'sample.schema.json';
const MODELINE = `# yaml-language-server: $schema=${SCHEMA_FOLDER.split(path.sep).join('/')}/${SCHEMA_FILE}\n`;

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
  fs.writeFileSync(path.join(schemaFolder, SCHEMA_FILE), labelSchemaText(labelDescription));
}

function writeOverlays(stack, labelDescriptionsByOverlay) {
  for (const [overlayName, labelDescription] of Object.entries(labelDescriptionsByOverlay)) {
    const overlayFolder = path.join(stack, overlayName);
    fs.mkdirSync(overlayFolder, { recursive: true });
    fs.writeFileSync(path.join(overlayFolder, 'mock.yml'), `${MODELINE}mocktype:\n  replica:\n    label: mock\n`);
    writeSchemaFolder(overlayFolder, labelDescription);
  }
}

function overlayHeadingOf(labels, theme = 'dark') {
  const color = `var(--vscode-yamlDslEditor-${theme}-overlayHeadingForeground)`;
  return `<span style="color:${color};"><strong>${labels}</strong></span>`;
}

module.exports = { SCHEMA_FOLDER, SCHEMA_FILE, labelSchemaText, writeSchemaFolder, writeOverlays, overlayHeadingOf };

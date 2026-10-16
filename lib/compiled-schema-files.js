const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEADER_PREFIX = '// yaml-dsl-editor compiled schema ';
const COMPILED_SCHEMA_FOLDER = 'compiled-schemas';

function compiledSchemaFileOf(storageFolder, configDir, dslId) {
  const entryHash = crypto.createHash('sha256').update(`${configDir}\n${dslId}`).digest('hex').slice(0, 32);
  return path.join(storageFolder, COMPILED_SCHEMA_FOLDER, `${entryHash}.js`);
}

function compiledSchemaFileStore(filePath, { schemaHash, buildKey }, reportProblem) {
  const headerLine = `${HEADER_PREFIX}${JSON.stringify({ schemaHash, buildKey })}\n`;

  function load() {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    return text.startsWith(headerLine) ? text.slice(headerLine.length) : null;
  }

  function save(source) {
    const writingPath = `${filePath}.writing`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(writingPath, `${headerLine}${source}`);
      fs.renameSync(writingPath, filePath);
    } catch (error) {
      reportProblem(`the compiled schema could not be saved to ${filePath}: ${error.message}`);
    }
  }

  return { filename: filePath, load, save };
}

module.exports = { compiledSchemaFileOf, compiledSchemaFileStore };

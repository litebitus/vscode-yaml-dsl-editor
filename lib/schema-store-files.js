const fs = require('fs');
const path = require('path');

const SCHEMA_STORE_FOLDER_NAME = 'schema-store';

function schemaStoreFolderOf(storageFolder) {
  return path.join(storageFolder, SCHEMA_STORE_FOLDER_NAME);
}

function schemaStoreFilesOf(folder, reportProblem) {
  const entryFileOf = (key) => path.join(folder, `${key}.json`);

  function read(key) {
    try {
      return fs.readFileSync(entryFileOf(key), 'utf8');
    } catch {
      return null;
    }
  }

  function write(key, prepared) {
    const entryFile = entryFileOf(key);
    const writingFile = `${entryFile}.writing`;
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(writingFile, prepared);
      fs.renameSync(writingFile, entryFile);
    } catch (error) {
      reportProblem(`the compiled schema could not be saved to ${entryFile}: ${error.message}`);
    }
  }

  return { read, write };
}

module.exports = { schemaStoreFolderOf, schemaStoreFilesOf };

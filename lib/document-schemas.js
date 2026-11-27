const path = require('path');
const { fileURLToPath } = require('url');
const { schemaValidation, schemaResolution } = require('yaml-dsl-spec');
const { GithubSchemaReader } = require('yaml-dsl-spec-schema-reader-github');
const { S3SchemaReader } = require('yaml-dsl-spec-schema-reader-s3');
const { problemMessageOf } = require('./config-problems');
const { DEFAULT_SCHEMA_STORE_CAPACITY } = require('./cache');

const KEPT_COPIES_FOLDER_NAME = 'schema-urls';
const ROLE_SESSION_NAME = 'yaml-dsl-editor';
const FILE_URL_PREFIX = 'file://';
const ERROR_SEVERITY = 'error';
const WARNING_SEVERITY = 'warning';

function watchedPathOf(fileUrl) {
  const schemaPath = fileURLToPath(fileUrl);
  const steps = schemaPath.split(path.sep);
  const firstPatternStep = steps.findIndex((step) => step.includes('*'));
  if (firstPatternStep < 0) return schemaPath;
  return steps.slice(0, firstPatternStep).join(path.sep) || path.sep;
}

function createDocumentSchemas({
  urlReaders = [new GithubSchemaReader(), new S3SchemaReader(ROLE_SESSION_NAME)],
  logInfo = () => {},
  logError = () => {},
} = {}) {
  let keptCopiesFolder = null;
  let storeCapacity = DEFAULT_SCHEMA_STORE_CAPACITY;
  let keptCopyFiles = null;
  const placeKeptCopyFiles = () => {
    keptCopyFiles = keptCopiesFolder
      ? new schemaValidation.SchemaFolderStore(keptCopiesFolder, storeCapacity, logError)
      : null;
  };
  const keptCopyStore = {
    read: (key) => (keptCopyFiles ? keptCopyFiles.read(key) : null),
    write: (key, keptCopy) => {
      if (keptCopyFiles) keptCopyFiles.write(key, keptCopy);
    },
  };
  const schemaCache = new schemaValidation.SchemaCache({ store: keptCopyStore, urlReaders });

  async function documentSchemaOf(filePath, text, searchPathTexts, configFolder) {
    const searchPaths = searchPathTexts.map((pathText) => ({ pathText, writtenAt: null }));
    const finding = await schemaCache.documentSchema(filePath, text, searchPaths, configFolder);
    for (const problem of finding.findingProblems) {
      logInfo(`schema of ${filePath}: ${problemMessageOf(problem)}`);
    }
    const watchedPaths = finding.triedCandidates
      .filter((candidate) => candidate.schemaLocation.startsWith(FILE_URL_PREFIX))
      .map((candidate) => watchedPathOf(candidate.schemaLocation));
    const found = finding.foundSchema;
    const findingError = finding.findingProblems.find((problem) => problem.severity === ERROR_SEVERITY);
    const modeline = schemaResolution.documentModeline(text);
    const isAtModeline = (problem) => modeline !== null && problem.position !== null
      && problem.position.line === modeline.line && problem.position.column === modeline.column;
    const modelineWarnings = finding.findingProblems
      .filter((problem) => problem.severity === WARNING_SEVERITY && isAtModeline(problem))
      .map(problemMessageOf);
    return {
      schemaText: found ? found.schemaText : null,
      schemaName: found ? found.schemaName : null,
      fragmentPointer: found ? found.schemaFragment : null,
      watchedPaths,
      error: findingError ? problemMessageOf(findingError) : null,
      modelineWarnings,
    };
  }

  function setStorageFolder(folder) {
    keptCopiesFolder = folder ? path.join(folder, KEPT_COPIES_FOLDER_NAME) : null;
    placeKeptCopyFiles();
  }

  function setStoreCapacity(capacity) {
    storeCapacity = capacity;
    placeKeptCopyFiles();
  }

  return { documentSchemaOf, setStorageFolder, setStoreCapacity };
}

module.exports = { createDocumentSchemas };

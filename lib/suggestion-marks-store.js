const { textHashOf } = require('./text-hash');

const STORE_FILE_NAME = 'suggestion-marks.json';
const STORE_FORMAT_VERSION = 3;
const SAVE_DELAY_MILLISECONDS = 1000;

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function filesFromStacks(stored) {
  if (!isPlainRecord(stored.stacks)) return null;
  const files = {};
  for (const [stackId, stackFiles] of Object.entries(stored.stacks)) {
    if (!Array.isArray(stackFiles)) continue;
    for (const file of stackFiles) {
      if (file && typeof file.uri === 'string') files[file.uri] = { stackId, textHash: null, marks: file.marks };
    }
  }
  return { version: 2, files };
}

function savedListsOfFiles(stored) {
  if (!isPlainRecord(stored.files)) return null;
  const files = {};
  for (const [uri, saved] of Object.entries(stored.files)) {
    if (isPlainRecord(saved)) files[uri] = [saved];
  }
  return { ...stored, version: 3, files };
}

const STORE_FORMAT_MIGRATIONS = new Map([[1, filesFromStacks], [2, savedListsOfFiles]]);

function markWithAddedFields(mark) {
  const fieldsAddedSinceFirstFormat = {
    keepsCommonValue: [],
    keepsOwnValue: [],
    createsCommonLayer: false,
    differencePaths: [],
    optOuts: [],
  };
  return { ...mark, suggestion: { ...fieldsAddedSinceFirstFormat, ...mark.suggestion } };
}

function migratedToCurrentFormat(stored) {
  let current = stored;
  while (isPlainRecord(current) && current.version !== STORE_FORMAT_VERSION) {
    const migration = STORE_FORMAT_MIGRATIONS.get(current.version);
    if (!migration) return null;
    current = migration(current);
  }
  return isPlainRecord(current) && isPlainRecord(current.files) ? current : null;
}

function createSuggestionMarksStore({ storageFolder, fileSystem, joinPath, parseUri, timerFunctions, buildHash }) {
  const marksByUri = new Map();
  const savedByUri = new Map();
  const urisByStack = new Map();
  const unverifiedUris = new Set();
  const otherBuildUris = new Set();
  let saveTimer = null;

  function storeFile() {
    return storageFolder ? joinPath(storageFolder, STORE_FILE_NAME) : null;
  }

  function savedListOf(uri) {
    return savedByUri.has(uri) ? [...savedByUri.get(uri).values()] : [];
  }

  function firstSavedOf(uri) {
    return savedListOf(uri)[0] || null;
  }

  function refreshMarksOf(uri) {
    const savedList = savedListOf(uri);
    if (savedList.length === 0) {
      savedByUri.delete(uri);
      marksByUri.delete(uri);
      return;
    }
    marksByUri.set(uri, savedList.flatMap((saved) => saved.marks));
  }

  function forgetStackFile(uri, stackId) {
    if (savedByUri.has(uri)) savedByUri.get(uri).delete(stackId);
    const stackUris = urisByStack.get(stackId);
    if (stackUris) stackUris.delete(uri);
    refreshMarksOf(uri);
  }

  function forgetFile(uri) {
    for (const saved of savedListOf(uri)) forgetStackFile(uri, saved.stackId);
    unverifiedUris.delete(uri);
  }

  function keepStackFile(uri, saved) {
    if (!savedByUri.has(uri)) savedByUri.set(uri, new Map());
    savedByUri.get(uri).set(saved.stackId, saved);
    if (!urisByStack.has(saved.stackId)) urisByStack.set(saved.stackId, new Set());
    urisByStack.get(saved.stackId).add(uri);
    refreshMarksOf(uri);
  }

  function replaceStack(stackId, files) {
    const changedUris = new Set(urisByStack.get(stackId) || []);
    for (const uri of changedUris) forgetStackFile(uri, stackId);
    for (const file of files) {
      keepStackFile(file.uri, {
        stackId,
        textHash: file.textHash,
        schemaHash: file.schemaHash || null,
        marks: file.marks,
        warning: file.warning === true,
        validationError: file.validationError === true,
      });
      changedUris.add(file.uri);
    }
    scheduleSave();
    return [...changedUris];
  }

  function keptSchemaHashes() {
    return [...savedByUri.keys()].map((uri) => ({ uri, schemaHash: firstSavedOf(uri).schemaHash }));
  }

  function warningUris() {
    return [...savedByUri.keys()].filter((uri) => savedListOf(uri).some((saved) => saved.warning));
  }

  function validationErrorUris() {
    return [...savedByUri.keys()].filter((uri) => savedListOf(uri).some((saved) => saved.validationError));
  }

  function clearUri(uri) {
    if ((marksByUri.get(uri) || []).length === 0) return false;
    marksByUri.set(uri, []);
    return true;
  }

  async function currentTextHash(uri) {
    try {
      return textHashOf(Buffer.from(await fileSystem.readFile(parseUri(uri))).toString('utf8'));
    } catch {
      return null;
    }
  }

  async function checkUri(uri) {
    const saved = firstSavedOf(uri);
    if (!saved) return false;
    if (await currentTextHash(uri) === saved.textHash) return false;
    forgetFile(uri);
    scheduleSave();
    return true;
  }

  function dropUri(uri) {
    if (!savedByUri.has(uri)) return false;
    forgetFile(uri);
    scheduleSave();
    return true;
  }

  async function deleteStoreFile(file) {
    try {
      await fileSystem.delete(file);
    } catch (error) {
      const reason = error && error.stack ? error.stack : error;
      console.error(`yaml-dsl suggestion marks in an unreadable format could not be deleted: ${reason}`);
    }
  }

  async function load() {
    const file = storeFile();
    if (!file) return { loaded: false };
    let storedText = null;
    try {
      storedText = Buffer.from(await fileSystem.readFile(file)).toString('utf8');
    } catch {
      return { loaded: false };
    }
    let stored = null;
    try {
      stored = JSON.parse(storedText);
    } catch {
      stored = null;
    }
    const current = migratedToCurrentFormat(stored);
    if (!current) {
      await deleteStoreFile(file);
      return { loaded: false };
    }
    if (!buildHash || current.build !== buildHash) {
      for (const uri of Object.keys(current.files)) if (!savedByUri.has(uri)) otherBuildUris.add(uri);
      scheduleSave();
      return { loaded: true };
    }
    for (const [uri, savedList] of Object.entries(current.files)) {
      if (savedByUri.has(uri) || !Array.isArray(savedList)) continue;
      for (const saved of savedList) {
        if (!isPlainRecord(saved) || typeof saved.stackId !== 'string' || !Array.isArray(saved.marks)) continue;
        const marks = saved.marks
          .filter((mark) => isPlainRecord(mark) && isPlainRecord(mark.suggestion))
          .map(markWithAddedFields);
        keepStackFile(uri, {
          stackId: saved.stackId,
          textHash: saved.textHash,
          schemaHash: saved.schemaHash || null,
          marks,
          warning: saved.warning === true,
          validationError: saved.validationError === true,
        });
      }
      if (savedByUri.has(uri)) unverifiedUris.add(uri);
    }
    if (current !== stored) scheduleSave();
    return { loaded: true };
  }

  async function verifySavedTexts() {
    const changedUris = [];
    const staleUris = [];
    for (const uri of [...otherBuildUris]) {
      otherBuildUris.delete(uri);
      if (!savedByUri.has(uri) && await currentTextHash(uri) !== null) staleUris.push(uri);
    }
    for (const uri of [...unverifiedUris]) {
      if (!unverifiedUris.has(uri)) continue;
      unverifiedUris.delete(uri);
      const { textHash } = firstSavedOf(uri);
      const currentHash = await currentTextHash(uri);
      const stillSaved = firstSavedOf(uri);
      if (currentHash === textHash || !stillSaved || stillSaved.textHash !== textHash) continue;
      forgetFile(uri);
      changedUris.push(uri);
      if (currentHash !== null) staleUris.push(uri);
    }
    if (changedUris.length > 0) scheduleSave();
    return { changedUris, staleUris };
  }

  async function save() {
    saveTimer = null;
    const file = storeFile();
    if (!file) return;
    const kept = (saved) => saved.marks.length > 0 || saved.warning || saved.validationError;
    const files = Object.fromEntries([...savedByUri.keys()]
      .map((uri) => [uri, savedListOf(uri).filter(kept)])
      .filter(([, savedList]) => savedList.length > 0));
    const text = JSON.stringify({ version: STORE_FORMAT_VERSION, build: buildHash || null, files });
    try {
      await fileSystem.createDirectory(storageFolder);
      await fileSystem.writeFile(file, Buffer.from(text, 'utf8'));
    } catch (error) {
      console.error(`yaml-dsl suggestion marks could not be saved: ${error && error.stack ? error.stack : error}`);
    }
  }

  function scheduleSave() {
    if (!storeFile()) return;
    if (saveTimer) timerFunctions.clearTimeout(saveTimer);
    saveTimer = timerFunctions.setTimeout(() => { save(); }, SAVE_DELAY_MILLISECONDS);
  }

  async function flush() {
    if (!saveTimer) return;
    timerFunctions.clearTimeout(saveTimer);
    await save();
  }

  return {
    marksByUri,
    replaceStack,
    warningUris,
    validationErrorUris,
    keptSchemaHashes,
    clearUri,
    checkUri,
    dropUri,
    load,
    verifySavedTexts,
    flush,
  };
}

module.exports = {
  createSuggestionMarksStore,
  STORE_FILE_NAME,
  STORE_FORMAT_VERSION,
  SAVE_DELAY_MILLISECONDS,
};

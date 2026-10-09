const { textHashOf } = require('./text-hash');

const STORE_FILE_NAME = 'suggestion-marks.json';
const STORE_FORMAT_VERSION = 2;
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

const STORE_FORMAT_MIGRATIONS = new Map([[1, filesFromStacks]]);

function markWithAddedFields(mark) {
  const fieldsAddedSinceFirstFormat = { keepsCommonValue: [], keepsOwnValue: [], createsCommonLayer: false };
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

function createSuggestionMarksStore({ storageFolder, fileSystem, joinPath, parseUri, timerFunctions }) {
  const marksByUri = new Map();
  const savedFiles = new Map();
  const urisByStack = new Map();
  const unverifiedUris = new Set();
  let saveTimer = null;

  function storeFile() {
    return storageFolder ? joinPath(storageFolder, STORE_FILE_NAME) : null;
  }

  function forgetFile(uri) {
    const saved = savedFiles.get(uri);
    if (!saved) return;
    savedFiles.delete(uri);
    marksByUri.delete(uri);
    unverifiedUris.delete(uri);
    const stackUris = urisByStack.get(saved.stackId);
    if (stackUris) stackUris.delete(uri);
  }

  function keepFile(uri, saved) {
    forgetFile(uri);
    savedFiles.set(uri, saved);
    marksByUri.set(uri, saved.marks);
    if (!urisByStack.has(saved.stackId)) urisByStack.set(saved.stackId, new Set());
    urisByStack.get(saved.stackId).add(uri);
  }

  function replaceStack(stackId, files) {
    const changedUris = new Set(urisByStack.get(stackId) || []);
    for (const uri of changedUris) forgetFile(uri);
    for (const file of files) {
      keepFile(file.uri, { stackId, textHash: file.textHash, marks: file.marks });
      changedUris.add(file.uri);
    }
    scheduleSave();
    return [...changedUris];
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
    const saved = savedFiles.get(uri);
    if (!saved) return false;
    if (await currentTextHash(uri) === saved.textHash) return false;
    forgetFile(uri);
    scheduleSave();
    return true;
  }

  function dropUri(uri) {
    if (!savedFiles.has(uri)) return false;
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
    for (const [uri, saved] of Object.entries(current.files)) {
      if (savedFiles.has(uri) || !saved || typeof saved.stackId !== 'string' || !Array.isArray(saved.marks)) continue;
      const marks = saved.marks
        .filter((mark) => isPlainRecord(mark) && isPlainRecord(mark.suggestion))
        .map(markWithAddedFields);
      keepFile(uri, { stackId: saved.stackId, textHash: saved.textHash, marks });
      unverifiedUris.add(uri);
    }
    if (current !== stored) scheduleSave();
    return { loaded: true };
  }

  async function verifySavedTexts() {
    const changedUris = [];
    const staleUris = [];
    for (const uri of [...unverifiedUris]) {
      if (!unverifiedUris.has(uri)) continue;
      unverifiedUris.delete(uri);
      const { textHash } = savedFiles.get(uri);
      const currentHash = await currentTextHash(uri);
      if (currentHash === textHash || !savedFiles.has(uri) || savedFiles.get(uri).textHash !== textHash) continue;
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
    const files = Object.fromEntries([...savedFiles].filter(([, saved]) => saved.marks.length > 0));
    const text = JSON.stringify({ version: STORE_FORMAT_VERSION, files });
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

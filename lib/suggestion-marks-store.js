const { textHashOf } = require('./text-hash');

const STORE_FILE_NAME = 'suggestion-marks.json';
const STORE_FORMAT_VERSION = 2;
const SAVE_DELAY_MILLISECONDS = 1000;

function createSuggestionMarksStore({ storageFolder, fileSystem, joinPath, parseUri, timerFunctions }) {
  const marksByUri = new Map();
  const savedFiles = new Map();
  const urisByStack = new Map();
  let saveTimer = null;

  function storeFile() {
    return storageFolder ? joinPath(storageFolder, STORE_FILE_NAME) : null;
  }

  function forgetFile(uri) {
    const saved = savedFiles.get(uri);
    if (!saved) return;
    savedFiles.delete(uri);
    marksByUri.delete(uri);
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
    for (const uri of [...(urisByStack.get(stackId) || [])]) forgetFile(uri);
    for (const file of files) keepFile(file.uri, { stackId, textHash: file.textHash, marks: file.marks });
    scheduleSave();
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

  async function load() {
    const file = storeFile();
    if (!file) return { loaded: false, staleUris: [] };
    let stored = null;
    try {
      stored = JSON.parse(Buffer.from(await fileSystem.readFile(file)).toString('utf8'));
    } catch {
      return { loaded: false, staleUris: [] };
    }
    if (!stored || stored.version !== STORE_FORMAT_VERSION || !stored.files || typeof stored.files !== 'object') {
      return { loaded: false, staleUris: [] };
    }
    const staleUris = [];
    for (const [uri, saved] of Object.entries(stored.files)) {
      if (savedFiles.has(uri) || !saved || typeof saved.stackId !== 'string' || !Array.isArray(saved.marks)) continue;
      const textHash = await currentTextHash(uri);
      if (textHash === null) continue;
      if (textHash !== saved.textHash) {
        staleUris.push(uri);
        continue;
      }
      keepFile(uri, { stackId: saved.stackId, textHash: saved.textHash, marks: saved.marks });
    }
    if (staleUris.length > 0) scheduleSave();
    return { loaded: true, staleUris };
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
    flush,
  };
}

module.exports = { createSuggestionMarksStore, STORE_FILE_NAME, SAVE_DELAY_MILLISECONDS };

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSuggestionMarksStore, STORE_FILE_NAME } = require('../lib/suggestion-marks-store');
const { textHashOf } = require('../lib/text-hash');

function memoryFileSystem(texts) {
  const files = new Map(Object.entries(texts).map(([uri, text]) => [uri, Buffer.from(text, 'utf8')]));
  return {
    files,
    readFile: async (uri) => {
      if (!files.has(uri.value)) throw new Error(`mock missing ${uri.value}`);
      return files.get(uri.value);
    },
    writeFile: async (uri, content) => { files.set(uri.value, content); },
    createDirectory: async () => {},
  };
}

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout: (callback) => {
      const timer = { callback };
      pending.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { pending.delete(timer); },
    fireAll: () => {
      const due = [...pending];
      pending.clear();
      for (const timer of due) timer.callback();
    },
  };
}

const MOCK_STORAGE_FOLDER = { value: 'mock-storage' };
const storePath = `${MOCK_STORAGE_FOLDER.value}/${STORE_FILE_NAME}`;

function storeOver(fileSystem, timers, storageFolder = MOCK_STORAGE_FOLDER) {
  return createSuggestionMarksStore({
    storageFolder,
    fileSystem,
    joinPath: (folder, name) => ({ value: `${folder.value}/${name}` }),
    parseUri: (uri) => ({ value: uri }),
    timerFunctions: timers,
  });
}

const devUri = 'file:///repo/dev/mock.yml';
const stagingUri = 'file:///repo/staging/mock.yml';
const devText = 'queue:\n  events: 1\n';
const stagingText = 'queue:\n  events: 2\n';
const mark = { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } }, suggestion: { id: 'mock' } };
const reported = (uri, text) => ({ uri, textHash: textHashOf(text), marks: [mark] });

test('marks are saved per file after a quiet second and load back in a new session while the file is unchanged', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const timers = manualTimers();
  const store = storeOver(fileSystem, timers);
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText), reported(stagingUri, stagingText)]);
  assert.equal(fileSystem.files.has(storePath), false);
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(Object.keys(saved.files).sort(), [devUri, stagingUri]);
  assert.equal(saved.files[devUri].stackId, '/repo/mock.yml');
  const restarted = storeOver(fileSystem, manualTimers());
  assert.deepEqual(await restarted.load(), { loaded: true, staleUris: [] });
  assert.deepEqual(restarted.marksByUri.get(devUri), [mark]);
});

test('a file changed or removed while the editor was closed loses its saved marks, and a changed one is reported stale', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const store = storeOver(fileSystem, manualTimers());
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText), reported(stagingUri, stagingText)]);
  await store.flush();
  fileSystem.files.set(devUri, Buffer.from('queue:\n  events: 9\n', 'utf8'));
  fileSystem.files.delete(stagingUri);
  const restarted = storeOver(fileSystem, manualTimers());
  assert.deepEqual(await restarted.load(), { loaded: true, staleUris: [devUri] });
  assert.equal(restarted.marksByUri.has(devUri), false);
  assert.equal(restarted.marksByUri.has(stagingUri), false);
});

test('a file that changes on disk during a session loses its marks only when its text differs', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const store = storeOver(fileSystem, manualTimers());
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  assert.equal(await store.checkUri(devUri), false);
  assert.deepEqual(store.marksByUri.get(devUri), [mark]);
  fileSystem.files.set(devUri, Buffer.from('queue:\n  events: 9\n', 'utf8'));
  assert.equal(await store.checkUri(devUri), true);
  assert.equal(store.marksByUri.has(devUri), false);
  assert.equal(await store.checkUri('file:///repo/unknown.yml'), false);
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  assert.equal(store.dropUri(devUri), true);
  assert.equal(store.dropUri(devUri), false);
});

test('a stack reported again replaces its marks, and an edit clears a file\'s marks without saving', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const store = storeOver(fileSystem, manualTimers());
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText), reported(stagingUri, stagingText)]);
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  assert.equal(store.marksByUri.has(stagingUri), false);
  assert.equal(store.clearUri(devUri), true);
  assert.deepEqual(store.marksByUri.get(devUri), []);
  assert.equal(store.clearUri(devUri), false);
  await store.flush();
  const restarted = storeOver(fileSystem, manualTimers());
  await restarted.load();
  assert.deepEqual(restarted.marksByUri.get(devUri), [mark]);
});

test('a session without workspace storage keeps marks in memory only', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const store = storeOver(fileSystem, manualTimers(), null);
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  await store.flush();
  assert.deepEqual(await store.load(), { loaded: false, staleUris: [] });
  assert.equal(fileSystem.files.size, 1);
  assert.deepEqual(store.marksByUri.get(devUri), [mark]);
});

test('a store file that is missing, unreadable or of another format loads nothing', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const nothing = { loaded: false, staleUris: [] };
  assert.deepEqual(await storeOver(fileSystem, manualTimers()).load(), nothing);
  fileSystem.files.set(storePath, Buffer.from('{not json', 'utf8'));
  assert.deepEqual(await storeOver(fileSystem, manualTimers()).load(), nothing);
  fileSystem.files.set(storePath, Buffer.from('{"version":1,"stacks":{}}', 'utf8'));
  assert.deepEqual(await storeOver(fileSystem, manualTimers()).load(), nothing);
});

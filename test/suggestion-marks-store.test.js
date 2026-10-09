const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSuggestionMarksStore,
  STORE_FILE_NAME,
  STORE_FORMAT_VERSION,
} = require('../lib/suggestion-marks-store');
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
    delete: async (uri) => {
      if (!files.delete(uri.value)) throw new Error(`mock missing ${uri.value}`);
    },
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
const loadedMark = {
  ...mark,
  suggestion: { keepsCommonValue: [], keepsOwnValue: [], createsCommonLayer: false, id: 'mock' },
};
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
  assert.deepEqual(await restarted.load(), { loaded: true });
  assert.deepEqual(restarted.marksByUri.get(devUri), [loadedMark]);
  assert.deepEqual(await restarted.verifySavedTexts(), { changedUris: [], staleUris: [] });
  assert.deepEqual(restarted.marksByUri.get(devUri), [loadedMark]);
});

test('a version 1 store, keyed by stack, migrates to the current format with every file stale and is saved again', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  fileSystem.files.set(storePath, Buffer.from(JSON.stringify({
    version: 1,
    stacks: { '/repo/mock.yml': [{ uri: devUri, marks: [mark] }, null], '/repo/other.yml': {} },
  }), 'utf8'));
  const timers = manualTimers();
  const store = storeOver(fileSystem, timers);
  assert.deepEqual(await store.load(), { loaded: true });
  assert.deepEqual(await store.verifySavedTexts(), { changedUris: [devUri], staleUris: [devUri] });
  assert.equal(store.marksByUri.has(devUri), false);
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(saved, { version: STORE_FORMAT_VERSION, files: {} });
});

test('a saved mark without the kept-value fields loads with them empty, and a malformed mark is dropped', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  fileSystem.files.set(storePath, Buffer.from(JSON.stringify({
    version: STORE_FORMAT_VERSION,
    files: { [devUri]: { stackId: '/repo/mock.yml', textHash: textHashOf(devText), marks: [mark, null, {}] } },
  }), 'utf8'));
  const store = storeOver(fileSystem, manualTimers());
  await store.load();
  assert.deepEqual(store.marksByUri.get(devUri), [loadedMark]);
});

test('saved marks show at once, then a file changed or removed while the editor was closed loses them, a changed one stale', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const store = storeOver(fileSystem, manualTimers());
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText), reported(stagingUri, stagingText)]);
  await store.flush();
  fileSystem.files.set(devUri, Buffer.from('queue:\n  events: 9\n', 'utf8'));
  fileSystem.files.delete(stagingUri);
  const restarted = storeOver(fileSystem, manualTimers());
  assert.deepEqual(await restarted.load(), { loaded: true });
  assert.deepEqual(restarted.marksByUri.get(devUri), [loadedMark]);
  const verified = await restarted.verifySavedTexts();
  assert.deepEqual(verified, { changedUris: [devUri, stagingUri], staleUris: [devUri] });
  assert.equal(restarted.marksByUri.has(devUri), false);
  assert.equal(restarted.marksByUri.has(stagingUri), false);
});

test('loading reads only the store file; the files it names are read when their texts are verified', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const store = storeOver(fileSystem, manualTimers());
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText), reported(stagingUri, stagingText)]);
  await store.flush();
  const reads = [];
  const readFile = fileSystem.readFile;
  fileSystem.readFile = async (uri) => {
    reads.push(uri.value);
    return readFile(uri);
  };
  const restarted = storeOver(fileSystem, manualTimers());
  await restarted.load();
  assert.deepEqual(reads, [storePath]);
  await restarted.verifySavedTexts();
  assert.deepEqual(reads.slice(1).sort(), [devUri, stagingUri]);
});

test('a stack worked out again while saved marks are being verified keeps its fresh marks', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const store = storeOver(fileSystem, manualTimers());
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  await store.flush();
  const editedText = 'queue:\n  events: 9\n';
  fileSystem.files.set(devUri, Buffer.from(editedText, 'utf8'));
  const restarted = storeOver(fileSystem, manualTimers());
  await restarted.load();
  const verifying = restarted.verifySavedTexts();
  assert.deepEqual(restarted.replaceStack('/repo/mock.yml', [reported(devUri, editedText)]), [devUri]);
  assert.deepEqual(await verifying, { changedUris: [], staleUris: [] });
  assert.deepEqual(restarted.marksByUri.get(devUri), [mark]);
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
  assert.deepEqual(restarted.marksByUri.get(devUri), [loadedMark]);
});

test('a session without workspace storage keeps marks in memory only', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const store = storeOver(fileSystem, manualTimers(), null);
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  await store.flush();
  assert.deepEqual(await store.load(), { loaded: false });
  assert.equal(fileSystem.files.size, 1);
  assert.deepEqual(store.marksByUri.get(devUri), [mark]);
});

test('a missing store file loads nothing, and one no migration reads is deleted', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const nothing = { loaded: false };
  assert.deepEqual(await storeOver(fileSystem, manualTimers()).load(), nothing);
  assert.equal(fileSystem.files.has(storePath), false);
  const unreadable = [
    '{not json',
    '{"version":99,"files":{}}',
    '{"version":1,"stacks":[]}',
    '{"version":2,"files":[]}',
  ];
  for (const text of unreadable) {
    fileSystem.files.set(storePath, Buffer.from(text, 'utf8'));
    assert.deepEqual(await storeOver(fileSystem, manualTimers()).load(), nothing);
    assert.equal(fileSystem.files.has(storePath), false);
  }
  const lockedFileSystem = { ...fileSystem, delete: async () => { throw new Error('mock locked'); } };
  fileSystem.files.set(storePath, Buffer.from('{not json', 'utf8'));
  const logged = [];
  const consoleError = console.error;
  console.error = (message) => logged.push(message);
  try {
    assert.deepEqual(await storeOver(lockedFileSystem, manualTimers()).load(), nothing);
  } finally {
    console.error = consoleError;
  }
  assert.match(logged[0], /^yaml-dsl suggestion marks in an unreadable format could not be deleted: Error: mock locked/);
});

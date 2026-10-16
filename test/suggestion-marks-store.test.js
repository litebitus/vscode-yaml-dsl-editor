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
const MOCK_BUILD_HASH = 'mock-build-hash';
const storePath = `${MOCK_STORAGE_FOLDER.value}/${STORE_FILE_NAME}`;

function storeOver(fileSystem, timers, storageFolder = MOCK_STORAGE_FOLDER, buildHash = MOCK_BUILD_HASH) {
  return createSuggestionMarksStore({
    storageFolder,
    fileSystem,
    joinPath: (folder, name) => ({ value: `${folder.value}/${name}` }),
    parseUri: (uri) => ({ value: uri }),
    timerFunctions: timers,
    buildHash,
  });
}

const devUri = 'file:///repo/dev/mock.yml';
const stagingUri = 'file:///repo/staging/mock.yml';
const devText = 'queue:\n  events: 1\n';
const stagingText = 'queue:\n  events: 2\n';
const mark = { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } }, suggestion: { id: 'mock' } };
const loadedMark = {
  ...mark,
  suggestion: {
    keepsCommonValue: [],
    keepsOwnValue: [],
    createsCommonLayer: false,
    differencePaths: [],
    optOuts: [],
    id: 'mock',
  },
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
  assert.deepEqual(saved.files[devUri].map((savedFile) => savedFile.stackId), ['/repo/mock.yml']);
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
  assert.equal(store.marksByUri.has(devUri), false);
  assert.deepEqual(await store.verifySavedTexts(), { changedUris: [], staleUris: [devUri] });
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(saved, { version: STORE_FORMAT_VERSION, build: MOCK_BUILD_HASH, files: {} });
});

test('a saved mark without the kept-value fields loads with them empty, and a malformed mark is dropped', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  fileSystem.files.set(storePath, Buffer.from(JSON.stringify({
    version: 2,
    build: MOCK_BUILD_HASH,
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

test('marks another build of the extension saved are never shown, and their files still on disk are stale', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const store = storeOver(fileSystem, manualTimers(), MOCK_STORAGE_FOLDER, 'mock-older-build-hash');
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText), reported(stagingUri, stagingText)]);
  await store.flush();
  fileSystem.files.delete(stagingUri);
  const timers = manualTimers();
  const upgraded = storeOver(fileSystem, timers);
  assert.deepEqual(await upgraded.load(), { loaded: true });
  assert.equal(upgraded.marksByUri.size, 0);
  assert.deepEqual(await upgraded.verifySavedTexts(), { changedUris: [], staleUris: [devUri] });
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(saved, { version: STORE_FORMAT_VERSION, build: MOCK_BUILD_HASH, files: {} });
});

test('a session that could not read its own build shows no saved marks, even ones saved the same way', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const store = storeOver(fileSystem, manualTimers(), MOCK_STORAGE_FOLDER, null);
  store.replaceStack('/repo/mock.yml', [reported(devUri, devText)]);
  await store.flush();
  const restarted = storeOver(fileSystem, manualTimers(), MOCK_STORAGE_FOLDER, null);
  await restarted.load();
  assert.equal(restarted.marksByUri.size, 0);
  assert.deepEqual(await restarted.verifySavedTexts(), { changedUris: [], staleUris: [devUri] });
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

test('a file holding only a warning is saved and loads back holding it, and a file saved before warnings holds none', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const timers = manualTimers();
  const store = storeOver(fileSystem, timers);
  store.replaceStack('/repo/mock.yml', [
    { uri: devUri, textHash: textHashOf(devText), marks: [], warning: true },
    { uri: stagingUri, textHash: textHashOf(stagingText), marks: [], warning: false },
  ]);
  assert.deepEqual(store.warningUris(), [devUri]);
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(Object.keys(saved.files), [devUri]);
  const reloaded = storeOver(fileSystem, manualTimers());
  await reloaded.load();
  assert.deepEqual(reloaded.warningUris(), [devUri]);
  const savedBeforeWarnings = {
    version: 2,
    build: MOCK_BUILD_HASH,
    files: { [stagingUri]: { stackId: '/repo/mock.yml', textHash: textHashOf(stagingText), marks: [mark] } },
  };
  fileSystem.files.set(storePath, Buffer.from(JSON.stringify(savedBeforeWarnings), 'utf8'));
  const older = storeOver(fileSystem, manualTimers());
  await older.load();
  assert.deepEqual(older.warningUris(), []);
});

test('a file holding only a validation error is saved and loads back holding it, and an older file holds none', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText, [stagingUri]: stagingText });
  const timers = manualTimers();
  const store = storeOver(fileSystem, timers);
  store.replaceStack('/repo/mock.yml', [
    { uri: devUri, textHash: textHashOf(devText), marks: [], validationError: true },
    { uri: stagingUri, textHash: textHashOf(stagingText), marks: [], validationError: false },
  ]);
  assert.deepEqual([store.validationErrorUris(), store.warningUris()], [[devUri], []]);
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(Object.keys(saved.files), [devUri]);
  const reloaded = storeOver(fileSystem, manualTimers());
  await reloaded.load();
  assert.deepEqual(reloaded.validationErrorUris(), [devUri]);
  const savedBeforeValidation = {
    version: 2,
    build: MOCK_BUILD_HASH,
    files: { [stagingUri]: { stackId: '/repo/mock.yml', textHash: textHashOf(stagingText), marks: [mark] } },
  };
  fileSystem.files.set(storePath, Buffer.from(JSON.stringify(savedBeforeValidation), 'utf8'));
  const older = storeOver(fileSystem, manualTimers());
  await older.load();
  assert.deepEqual(older.validationErrorUris(), []);
});

test('each kept file\'s schema hash is saved and loads back, and a file saved before schema hashes holds none', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const timers = manualTimers();
  const store = storeOver(fileSystem, timers);
  store.replaceStack('/repo/mock.yml', [{ ...reported(devUri, devText), schemaHash: 'mock-schema-hash' }]);
  assert.deepEqual(store.keptSchemaHashes(), [{ uri: devUri, schemaHash: 'mock-schema-hash' }]);
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const reloaded = storeOver(fileSystem, manualTimers());
  await reloaded.load();
  assert.deepEqual(reloaded.keptSchemaHashes(), [{ uri: devUri, schemaHash: 'mock-schema-hash' }]);
  const savedBeforeSchemaHashes = {
    version: 2,
    build: MOCK_BUILD_HASH,
    files: { [devUri]: { stackId: '/repo/mock.yml', textHash: textHashOf(devText), marks: [mark] } },
  };
  fileSystem.files.set(storePath, Buffer.from(JSON.stringify(savedBeforeSchemaHashes), 'utf8'));
  const older = storeOver(fileSystem, manualTimers());
  await older.load();
  assert.deepEqual(older.keptSchemaHashes(), [{ uri: devUri, schemaHash: null }]);
});

test('a file in two stacks keeps the marks of both, and one stack reported again replaces only its own', async () => {
  const fileSystem = memoryFileSystem({ [devUri]: devText });
  const timers = manualTimers();
  const store = storeOver(fileSystem, timers);
  const otherMark = { ...mark, suggestion: { id: 'mock-other' } };
  store.replaceStack('/repo/mock-a.yml', [reported(devUri, devText)]);
  store.replaceStack('/repo/mock-b.yml', [{ uri: devUri, textHash: textHashOf(devText), marks: [otherMark] }]);
  assert.deepEqual(store.marksByUri.get(devUri), [mark, otherMark]);
  store.replaceStack('/repo/mock-a.yml', []);
  assert.deepEqual(store.marksByUri.get(devUri), [otherMark]);
  store.replaceStack('/repo/mock-a.yml', [reported(devUri, devText)]);
  timers.fireAll();
  await new Promise((resolve) => { setImmediate(resolve); });
  const saved = JSON.parse(fileSystem.files.get(storePath).toString('utf8'));
  assert.deepEqual(saved.files[devUri].map((savedFile) => savedFile.stackId), ['/repo/mock-b.yml', '/repo/mock-a.yml']);
  const reloaded = storeOver(fileSystem, manualTimers());
  await reloaded.load();
  assert.equal(reloaded.marksByUri.get(devUri).length, 2);
});

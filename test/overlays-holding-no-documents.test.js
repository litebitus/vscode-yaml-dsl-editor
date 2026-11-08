const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createWorkspace } = require('../lib/workspace');
const {
  scope,
  declaration,
  reference,
  markerFunction,
  dslEntry,
  configText,
} = require('./config-builders');

const OVERLAY_FOLDERS = ['overlay-1', 'overlay-2', 'overlay-3'];
const SCHEMA_FILE = path.join('.schema', 'mock-dsl.schema.json');
const SHARED_LABEL_TEXT = 'mocktype:\n  shared:\n    label: mock-shared\n';
const OVERLAY_SIZE_TEXT = 'mocktype:\n  shared:\n    size: 1\n';

function layeredConfig(commonLayerDiscovery, overlayFolders) {
  return configText(dslEntry('mock-dsl', {
    file_includes: ['**/mock-dsl.yml'],
    schema_search_paths: [SCHEMA_FILE],
    layers: {
      overlay_folders: overlayFolders,
      common_layer_discovery: commonLayerDiscovery,
      common_layer_files: commonLayerDiscovery === 'ancestor'
        ? { 'mock-dsl.yml': ['{concern}.mock-dsl.yml', 'mock-dsl.yml'] }
        : {},
      duplicate_check: { depth: 2, key_depths: {}, skip_keys: [] },
    },
    key_sort_orders: [
      { path: '$', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
      { path: '$..*', skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] },
    ],
    function: markerFunction({ definitions: ['schema'] }),
    scopes: { local: scope() },
    declarations: [declaration('$.locals.*', 'local')],
    references: [reference('^local\\.(?<name>[a-z0-9_]+)$', 'local')],
  }));
}

function mockFunctionTable(functionName) {
  return {
    [functionName]: {
      description: 'Mock function.',
      arguments: [],
      return: { type: 'text', description: 'Mock text.' },
    },
  };
}

function labelSchemaText(labelType, functionTable = {}) {
  return JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    'x-yaml-dsl-functions': functionTable,
    properties: {
      mocktype: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { label: { type: labelType, description: `Mock ${labelType} label.` } },
        },
      },
    },
  });
}

function folderEntriesOver(files) {
  return async (folderPath) => {
    const entryKinds = new Map();
    for (const heldPath of Object.keys(files)) {
      const relativePath = path.relative(folderPath, heldPath);
      const outsideFolder = relativePath.startsWith('..') || path.isAbsolute(relativePath);
      if (relativePath === '' || outsideFolder) continue;
      const [firstStep, ...laterSteps] = relativePath.split(path.sep);
      entryKinds.set(firstStep, entryKinds.get(firstStep) || laterSteps.length > 0);
    }
    if (entryKinds.size === 0) return null;
    return [...entryKinds].map(([name, isFolder]) => ({ name, isFolder }));
  };
}

async function workspaceOver(files, commonLayerDiscovery, overlayFolders = OVERLAY_FOLDERS) {
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    readFolderEntries: folderEntriesOver(files),
    fetchText: async () => null,
    timerFunctions: { setTimeout: () => null, clearTimeout: () => {} },
  });
  const layeredConfigText = layeredConfig(commonLayerDiscovery, overlayFolders);
  await ws.setConfigs([{ text: layeredConfigText, dir: '/repo' }]);
  return ws;
}

function overlaySchemas(stackFolder, labelTypesByOverlay) {
  return Object.fromEntries(Object.entries(labelTypesByOverlay)
    .map(([overlayFolder, labelType]) => [
      path.join(stackFolder, overlayFolder, SCHEMA_FILE),
      labelSchemaText(labelType),
    ]));
}

function parentStackFiles(root) {
  return {
    [`${root}/mock-dsl.yml`]: SHARED_LABEL_TEXT,
    [path.join(root, SCHEMA_FILE)]: labelSchemaText('string'),
    [`${root}/overlay-1/mock-dsl.yml`]: OVERLAY_SIZE_TEXT,
    [`${root}/overlay-2/mock-dsl.yml`]: OVERLAY_SIZE_TEXT,
    ...overlaySchemas(root, {
      'overlay-1': 'string',
      'overlay-2': 'string',
      'overlay-3': 'integer',
    }),
  };
}

async function problemMessagesOf(ws, files, filePath) {
  await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  return ws.problems(`file://${filePath}`).map((problem) => problem.message);
}

function watchesPattern(ws, base, pattern) {
  return ws.layerWatchTargets()
    .some((target) => target.base === base && target.pattern === pattern);
}

function at(text, needle) {
  const index = text.indexOf(needle);
  const line = text.slice(0, index).split('\n').length - 1;
  return { line, character: index - text.lastIndexOf('\n', index - 1) - 1 };
}

const LABEL_INTEGER_PROBLEM = '`label` must be `integer`';
const OVERLAY_3_PROBLEM = `${LABEL_INTEGER_PROBLEM} (overlay-3)`;

let ws = null;

test.beforeEach(() => {
  ws = null;
});

test.afterEach(() => {
  if (ws) ws.dispose();
});

test('parent: an overlay directory holding no overlay file validates the common layer alone, '
  + 'against the schema found from its place, named like any other overlay', async () => {
  const root = '/repo/concern-1';
  const files = parentStackFiles(root);
  ws = await workspaceOver(files, 'parent');
  assert.deepEqual(await problemMessagesOf(ws, files, `${root}/mock-dsl.yml`), [OVERLAY_3_PROBLEM]);
  assert.deepEqual(await problemMessagesOf(ws, files, `${root}/overlay-1/mock-dsl.yml`), []);
});

test('an overlay directory that does not exist is no overlay of the stack', async () => {
  const root = '/repo/concern-1';
  const files = parentStackFiles(root);
  delete files[path.join(root, 'overlay-3', SCHEMA_FILE)];
  ws = await workspaceOver(files, 'parent');
  assert.deepEqual(await problemMessagesOf(ws, files, `${root}/mock-dsl.yml`), []);
  const diffedOverlays = ws.overlayDiffStack(`file://${root}/mock-dsl.yml`).overlayNames;
  assert.deepEqual(diffedOverlays, ['overlay-1', 'overlay-2']);
});

test('ancestor: an overlay directory holding the place the other overlays take, '
  + 'below a concern, validates the concern\'s common layer alone', async () => {
  const group = '/repo/concern-group';
  const common = `${group}/concern-1.mock-dsl.yml`;
  const files = {
    [common]: SHARED_LABEL_TEXT,
    [path.join(group, SCHEMA_FILE)]: labelSchemaText('string'),
    [`${group}/overlay-1/concern-1/mock-dsl.yml`]: OVERLAY_SIZE_TEXT,
    [`${group}/overlay-2/concern-1/mock-dsl.yml`]: OVERLAY_SIZE_TEXT,
    ...overlaySchemas(group, {
      'overlay-1/concern-1': 'string',
      'overlay-2/concern-1': 'string',
      'overlay-3/concern-1': 'integer',
    }),
    [`${group}/overlay-3/mock-notes.txt`]: 'mock notes\n',
  };
  ws = await workspaceOver(files, 'ancestor');
  assert.deepEqual(await problemMessagesOf(ws, files, common), [OVERLAY_3_PROBLEM]);
});

test('ancestor: an overlay directory holding no overlay file at the common layer\'s own depth '
  + 'validates the common layer alone', async () => {
  const root = '/repo/concern-2';
  const files = parentStackFiles(root);
  ws = await workspaceOver(files, 'ancestor');
  assert.deepEqual(await problemMessagesOf(ws, files, `${root}/mock-dsl.yml`), [OVERLAY_3_PROBLEM]);
});

test('ancestor: a concern\'s own common layer takes the concern as its place '
  + 'when only other concerns hold overlay files', async () => {
  const group = '/repo/concern-group';
  const common = `${group}/concern-3.mock-dsl.yml`;
  const files = {
    [common]: SHARED_LABEL_TEXT,
    [path.join(group, SCHEMA_FILE)]: labelSchemaText('string'),
    [`${group}/overlay-1/concern-1/mock-dsl.yml`]: OVERLAY_SIZE_TEXT,
    ...overlaySchemas(group, { 'overlay-3/concern-3': 'integer' }),
  };
  ws = await workspaceOver(files, 'ancestor');
  assert.deepEqual(await problemMessagesOf(ws, files, common), [OVERLAY_3_PROBLEM]);
  assert.ok(watchesPattern(ws, group, 'overlay-1/**'));
});

for (const commonLayerDiscovery of ['parent', 'ancestor']) {
  test(`${commonLayerDiscovery}: a common layer with no overlay file in any overlay directory `
    + 'is a document with no overlays, validated alone against its own schema', async () => {
    const root = '/repo/concern-4';
    const files = {
      [`${root}/mock-dsl.yml`]: SHARED_LABEL_TEXT,
      [path.join(root, SCHEMA_FILE)]: labelSchemaText('integer'),
      [`${root}/overlay-1/mock-notes/mock-notes.txt`]: 'mock notes\n',
      ...overlaySchemas(root, { 'overlay-2': 'string' }),
    };
    ws = await workspaceOver(files, commonLayerDiscovery);
    const messages = await problemMessagesOf(ws, files, `${root}/mock-dsl.yml`);
    assert.deepEqual(messages, [LABEL_INTEGER_PROBLEM]);
    assert.deepEqual(ws.overlayDiffStack(`file://${root}/mock-dsl.yml`).overlayNames, []);
  });
}

test('ancestor: a common layer whose overlay directories hold overlay files of other stacks '
  + 'is not a document with no overlays', async () => {
  const group = '/repo/concern-group';
  const common = `${group}/mock-dsl.yml`;
  const files = {
    [common]: SHARED_LABEL_TEXT,
    [path.join(group, SCHEMA_FILE)]: labelSchemaText('integer'),
    [`${group}/overlay-1/concern-1/mock-dsl.yml`]: OVERLAY_SIZE_TEXT,
  };
  ws = await workspaceOver(files, 'ancestor');
  assert.deepEqual(await problemMessagesOf(ws, files, common), []);
});

test('a place folder appearing or going, and an overlay file created or deleted, '
  + 'rebuild the stack around them', async () => {
  const root = '/repo/concern-1';
  const files = parentStackFiles(root);
  const placeSchema = path.join(root, 'overlay-3', SCHEMA_FILE);
  const placeSchemaText = files[placeSchema];
  delete files[placeSchema];
  ws = await workspaceOver(files, 'parent');
  const common = `${root}/mock-dsl.yml`;
  const commonMessages = () => ws.problems(`file://${common}`).map((problem) => problem.message);
  assert.deepEqual(await problemMessagesOf(ws, files, common), []);
  assert.ok(watchesPattern(ws, root, 'overlay-3'));
  files[placeSchema] = placeSchemaText;
  await ws.layersChanged([`${root}/overlay-3`]);
  assert.deepEqual(commonMessages(), [OVERLAY_3_PROBLEM]);
  const overlayFile = `${root}/overlay-3/mock-dsl.yml`;
  files[overlayFile] = 'mocktype:\n  shared:\n    label: 3\n';
  await ws.layersChanged([overlayFile]);
  assert.deepEqual(commonMessages(), []);
  delete files[overlayFile];
  await ws.layersChanged([overlayFile]);
  assert.deepEqual(commonMessages(), [OVERLAY_3_PROBLEM]);
  delete files[placeSchema];
  await ws.layersChanged([`${root}/overlay-3`]);
  assert.deepEqual(commonMessages(), []);
});

test('the common layer is documented, resolved and diffed through the fold '
  + 'of an overlay holding no documents', async () => {
  const root = '/repo/concern-1';
  const common = `${root}/mock-dsl.yml`;
  const files = {
    ...parentStackFiles(root),
    [common]: 'mocktype:\n  shared:\n    label: local.owner\n',
    [`${root}/overlay-1/mock-dsl.yml`]: 'locals:\n  owner: mock-owner\n',
    [`${root}/overlay-2/mock-dsl.yml`]: 'locals:\n  owner: mock-owner\n',
  };
  ws = await workspaceOver(files, 'parent');
  await ws.sync(`file://${common}`, common, files[common]);
  const hoverText = ws.hover(`file://${common}`, at(files[common], 'label')).contents.value;
  assert.match(hoverText, /<strong>overlay-1, overlay-2<\/strong>.*\n\n`label`: \*string\*/);
  assert.match(hoverText, /<strong>overlay-3<\/strong>.*\n\n`label`: \*integer\*/);
  assert.deepEqual(ws.references(`file://${common}`).map((found) => found.kind), ['error']);
  assert.deepEqual(
    ws.overlayDiffStack(`file://${common}`).overlayNames,
    ['overlay-1', 'overlay-2', 'overlay-3'],
  );
  const diff = ws.overlayDiff(`file://${common}`, {
    start: { line: 0, character: 0 },
    end: { line: 2, character: 0 },
  }, OVERLAY_FOLDERS);
  assert.match(diff.lines.map((line) => line.text).join('\n'), /overlay-3/);
});

test('the common layer\'s functions take the function table of an overlay holding no documents, '
  + 'and its names those declared in every overlay', async () => {
  const root = '/repo/concern-1';
  const common = `${root}/mock-dsl.yml`;
  const commonText = 'locals:\n  shared: local.\nmocktype:\n  fn.\n';
  const files = {
    ...parentStackFiles(root),
    [common]: commonText,
    [`${root}/overlay-1/mock-dsl.yml`]: 'locals:\n  owner: mock-owner\n',
    [`${root}/overlay-2/mock-dsl.yml`]: 'locals:\n  owner: mock-owner\n',
    [path.join(root, 'overlay-3', SCHEMA_FILE)]:
      labelSchemaText('integer', mockFunctionTable('mock_upper')),
  };
  ws = await workspaceOver(files, 'parent');
  await ws.sync(`file://${common}`, common, commonText);
  const labelsAt = (line, lineText) => ws
    .completion(`file://${common}`, { line, character: lineText.length })
    .map((item) => item.label);
  assert.ok(labelsAt(3, '  fn.').includes('fn.mock_upper'));
  assert.ok(!labelsAt(1, '  shared: local.').includes('local.owner'));
});

const OPEN_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
});

function suggestionStackFiles(root, layerTexts) {
  return {
    [`${root}/mock-dsl.yml`]: layerTexts.common,
    [`${root}/overlay-1/mock-dsl.yml`]: layerTexts.overlay,
    [`${root}/overlay-2/mock-dsl.yml`]: layerTexts.overlay,
    [path.join(root, SCHEMA_FILE)]: OPEN_SCHEMA_TEXT,
    [path.join(root, 'overlay-1', SCHEMA_FILE)]: OPEN_SCHEMA_TEXT,
    [path.join(root, 'overlay-2', SCHEMA_FILE)]: OPEN_SCHEMA_TEXT,
    [path.join(root, 'overlay-3', SCHEMA_FILE)]: layerTexts.placeSchema || OPEN_SCHEMA_TEXT,
  };
}

async function workedOutSuggestions(files, root) {
  const stackId = `${root}/mock-dsl.yml`;
  const overlayPath = `${root}/overlay-1/mock-dsl.yml`;
  await ws.sync(`file://${overlayPath}`, overlayPath, files[overlayPath]);
  await ws.queueSuggestions(stackId);
  const marks = ws.suggestionMarks(stackId).files.flatMap((file) => file.marks);
  return [...new Map(marks.map((mark) => [mark.suggestion.id, mark.suggestion])).values()];
}

function createdTextOf(applied, filePath) {
  const created = applied.files.find((file) => file.uri === `file://${filePath}`);
  if (!created || !created.fileCreated) return null;
  const textChange = applied.edit.documentChanges
    .find((change) => change.textDocument && change.textDocument.uri === `file://${filePath}`);
  return textChange.edits[0].newText;
}

function offsetAt(text, position) {
  const lineStarts = text.split('\n').slice(0, position.line)
    .reduce((offset, line) => offset + line.length + 1, 0);
  return lineStarts + position.character;
}

function writtenTextsOf(applied, files) {
  const changedPaths = [];
  for (const change of applied.edit.documentChanges.filter((held) => held.textDocument)) {
    const filePath = change.textDocument.uri.slice('file://'.length);
    let text = files[filePath] || '';
    for (const edit of change.edits) {
      const start = offsetAt(text, edit.range.start);
      text = `${text.slice(0, start)}${edit.newText}${text.slice(offsetAt(text, edit.range.end))}`;
    }
    files[filePath] = text;
    changedPaths.push(filePath);
  }
  return changedPaths;
}

test('a unit every overlay with a document holds alike is a potential move, whose click creates '
  + 'the document of the overlay holding no documents holding the opt-out', async () => {
  const root = '/repo/concern-5';
  const files = suggestionStackFiles(root, {
    common: 'other: mock-other\n',
    overlay: OVERLAY_SIZE_TEXT,
  });
  ws = await workspaceOver(files, 'parent');
  const [suggestion] = await workedOutSuggestions(files, root);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.absent, ['overlay-3']);
  assert.deepEqual(suggestion.differencePaths, [['mocktype', 'shared']]);
  const optOut = { overlay: 'overlay-3', relativePath: [], valueText: '{}' };
  assert.deepEqual(suggestion.optOuts, [optOut]);
  const applied = await ws.applySuggestion(`${root}/mock-dsl.yml`, suggestion.id);
  const placeDocument = `${root}/overlay-3/mock-dsl.yml`;
  assert.equal(createdTextOf(applied, placeDocument), 'mocktype:\n  shared: {}\n');
  assert.deepEqual(applied.edit.documentChanges[0], {
    kind: 'create',
    uri: `file://${placeDocument}`,
    options: { ignoreIfExists: true },
  });
  assert.doesNotMatch(ws.foldText(`${root}/mock-dsl.yml`, 'overlay-3'), /size/);
  const changedPaths = writtenTextsOf(applied, files);
  await ws.layersChanged(changedPaths);
  const { data } = ws.cache.get(`${root}/mock-dsl.yml`);
  assert.deepEqual(data.overlaysHoldingNoDocuments, []);
  assert.equal(data.files.has(placeDocument), true);
  assert.match(ws.foldText(`${root}/mock-dsl.yml`, 'overlay-1'), /shared:\n {4}size: 1/);
  assert.doesNotMatch(ws.foldText(`${root}/mock-dsl.yml`, 'overlay-3'), /size/);
});

test('a value move counts an overlay holding no documents as holding nothing, '
  + 'and its click creates that document holding the common layer\'s former value', async () => {
  const root = '/repo/concern-6';
  const files = suggestionStackFiles(root, {
    common: 'mocktype:\n  size: 1\n',
    overlay: 'mocktype:\n  size: 2\n',
  });
  ws = await workspaceOver(files, 'parent');
  const [suggestion] = await workedOutSuggestions(files, root);
  assert.deepEqual(suggestion.holders, ['overlay-1', 'overlay-2']);
  assert.equal(suggestion.overlayCount, 3);
  assert.deepEqual(suggestion.keepsCommonValue, ['overlay-3']);
  const applied = await ws.applySuggestion(`${root}/mock-dsl.yml`, suggestion.id);
  assert.equal(createdTextOf(applied, `${root}/overlay-3/mock-dsl.yml`), 'mocktype:\n  size: 1\n');
});

test('schema check 1 reads the schema an overlay holding no documents '
  + 'finds from its place', async () => {
  const root = '/repo/concern-7';
  const files = suggestionStackFiles(root, {
    common: 'other: mock-other\n',
    overlay: OVERLAY_SIZE_TEXT,
    placeSchema: labelSchemaText('integer'),
  });
  ws = await workspaceOver(files, 'parent');
  const [suggestion] = await workedOutSuggestions(files, root);
  assert.equal(suggestion.kind, 'potential_move');
  assert.ok(suggestion.schemaGroups.some((group) => group.overlays.includes('overlay-3')));
  const refused = await ws.applySuggestion(`${root}/mock-dsl.yml`, suggestion.id);
  assert.equal(refused.problem, 'a potential move has no edit to apply');
});

test('ancestor: a unit the two overlays holding documents hold alike is a potential move '
  + 'while two overlays hold no documents, the majority read among overlays holding documents',
async () => {
  const root = '/repo/concern-8';
  const sharedText = 'mocksource:\n  mock_shared:\n    type: mock-kind\n';
  const files = {
    [`${root}/mock-dsl.yml`]: 'other: mock-other\n',
    [`${root}/overlay-1/mock-dsl.yml`]: sharedText,
    [`${root}/overlay-2/mock-dsl.yml`]: sharedText,
    [`${root}/overlay-3/mock-notes.txt`]: 'mock notes\n',
    [`${root}/overlay-4/mock-settings.txt`]: 'mock settings\n',
  };
  ws = await workspaceOver(files, 'ancestor', [...OVERLAY_FOLDERS, 'overlay-4']);
  const [suggestion] = await workedOutSuggestions(files, root);
  assert.equal(suggestion.kind, 'move');
  assert.deepEqual(suggestion.absent, ['overlay-3', 'overlay-4']);
  assert.deepEqual(suggestion.differencePaths, [['mocksource', 'mock_shared']]);
  assert.equal(suggestion.overlayCount, 4);
  const applied = await ws.applySuggestion(`${root}/mock-dsl.yml`, suggestion.id);
  for (const overlayName of ['overlay-3', 'overlay-4']) {
    const placeDocument = `${root}/${overlayName}/mock-dsl.yml`;
    assert.equal(createdTextOf(applied, placeDocument), 'mocksource:\n  mock_shared: {}\n');
  }
});

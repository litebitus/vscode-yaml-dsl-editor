const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { dslEntry, configText } = require('./config-builders');

const config = configText(dslEntry('sample', {
  file_includes: ['**/mock.yml'],
  layers: {
    overlay_folders: ['overlay-1', 'overlay-2', 'overlay-3'],
    common_layer_discovery: 'ancestor',
    common_layer_files: { 'mock.yml': ['{concern}.mock.yml', 'mock.yml'] },
    duplicate_check: { depth: 2, key_depths: {}, skip_keys: [] },
  },
}), dslEntry('flat', { file_includes: ['**/flat.yml'] }));

const files = {
  '/repo/group/mock.yml': 'mocktype:\n  shared:\n    label: mock-fallback\n',
  '/repo/group/concern-1.mock.yml': 'mocktype:\n  shared:\n    label: mock-shared\n',
  '/repo/group/overlay-1/concern-1/mock.yml': 'mocktype:\n  shared:\n    size: 1\n',
  '/repo/group/overlay-2/concern-1/mock.yml': 'mocktype:\n  shared:\n    size: 2\n',
  '/repo/apps/concern-2/mock.yml': 'mocktype:\n  shared:\n    label: mock-app\n',
  '/repo/apps/concern-2/overlay-1/mock.yml': 'mocktype:\n  shared:\n    size: 1\n',
  '/repo/apps/concern-2/overlay-3/mock.yml': 'mocktype:\n  shared:\n    size: 1\n',
  '/repo/notes/flat.yml': 'mocktype:\n  shared: {}\n',
};

function selection(startLine, startCharacter, endLine, endCharacter) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

async function openedWorkspace(...paths) {
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  for (const filePath of paths) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  return ws;
}

test('a concern below its overlays diffs the overlays checked, folded with its own common layer, titled by its path', async () => {
  const overlay = '/repo/group/overlay-1/concern-1/mock.yml';
  const ws = await openedWorkspace(overlay);
  const uri = `file://${overlay}`;
  assert.deepEqual(ws.overlayDiffStack(uri), {
    title: 'group/concern-1',
    overlayNames: ['overlay-1', 'overlay-2'],
    overlayLabels: ['overlay-1', 'overlay-2'],
  });
  const diff = ws.overlayDiff(uri, selection(1, 0, 2, 11), ['overlay-2', 'overlay-1', 'overlay-3']);
  assert.equal(diff.title, 'group/concern-1');
  assert.deepEqual(diff.lines.map((line) => line.text), [
    '# overlay-1, overlay-2: 1 difference',
    'mocktype:',
    '  shared:',
    '    label: mock-shared',
    '    size: 1  # overlay-1',
    '    size: 2  # overlay-2',
  ]);
  assert.deepEqual(ws.overlayDiff(uri, selection(1, 0, 2, 11), ['overlay-2']).lines.map((line) => line.text), [
    '# overlay-2: no differences',
    'mocktype:',
    '  shared:',
    '    label: mock-shared',
    '    size: 2',
  ]);
});

test('a concern above its overlays is titled by its full path from the workspace root', async () => {
  const overlay = '/repo/apps/concern-2/overlay-3/mock.yml';
  const ws = await openedWorkspace(overlay);
  const uri = `file://${overlay}`;
  assert.deepEqual(ws.overlayDiffStack(uri), {
    title: 'apps/concern-2',
    overlayNames: ['overlay-1', 'overlay-3'],
    overlayLabels: ['overlay-1', 'overlay-3'],
  });
  const diff = ws.overlayDiff(uri, selection(2, 0, 2, 9), ['overlay-1', 'overlay-3']);
  assert.equal(diff.title, 'apps/concern-2');
  assert.deepEqual(diff.lines.map((line) => line.text), [
    '# overlay-1, overlay-3: no differences',
    'mocktype:',
    '  shared:',
    '    size: 1',
  ]);
});

test('a file outside a layered stack, or a selection holding no key, gives no diff', async () => {
  const overlay = '/repo/group/overlay-1/concern-1/mock.yml';
  const flat = '/repo/notes/flat.yml';
  const ws = await openedWorkspace(overlay, flat);
  const uri = `file://${overlay}`;
  assert.equal(ws.overlayDiffStack(`file://${flat}`), null);
  assert.equal(ws.overlayDiff(`file://${flat}`, selection(0, 0, 1, 3), ['overlay-1']), null);
  assert.equal(ws.overlayDiffStack('file:///repo/unopened/mock.yml'), null);
  assert.equal(ws.overlayDiff('file:///repo/unopened/mock.yml', selection(0, 0, 1, 3), ['overlay-1']), null);
  assert.equal(ws.overlayDiff(uri, selection(4, 0, 4, 0), ['overlay-1']), null);
});

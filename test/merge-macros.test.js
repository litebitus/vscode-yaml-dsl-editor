const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const {
  mergeContextOf,
  mergedValueOf,
  preMergePathOf,
  mergeTreeContextOf,
  mergedTreeOf,
} = require('../lib/merge-macros');
const { parseYaml } = require('../lib/tree');
const { collectSymbols } = require('../lib/symbols');
const {
  unitedTableOf,
  calledEntryOf,
  tableEntriesOf,
  tableEntryKindOf,
} = require('../lib/function-calls');
const {
  scope,
  declaration,
  reference,
  markerFunction,
  dslEntry,
  configText,
  parsedDsl,
} = require('./config-builders');

const mergeMacro = (mergeBehavior, repeated = true) => ({
  description: 'Merges the mock contents.',
  arguments: [{ name: 'contents', type: 'map', required: true, repeated, description: 'The mock contents.' }],
  return: null,
  macro: { kind: 'merge', nameSuffixPattern: null, unmarkedKeyPaths: [], mergeBehavior, roles: { content: 'contents' } },
});

const mergedEntry = dslEntry('merged', {
  file_includes: ['**/mock.yml'],
  schema_search_paths: ['{config_root}/mock-stack/schema.json'],
  layers: {
    overlay_folders: ['one'],
    common_layer_discovery: 'ancestor',
    duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
  },
  function: markerFunction({ definitions: ['schema'] }),
  locals: { scope_name: 'local' },
  scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
  declarations: [declaration('$.locals.*', 'local')],
  references: [
    reference('^local\\.(?<name>[a-z0-9_]+)$', 'local'),
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', 'ENTRY', {
      text_after_name_allowed: true,
      scope_group: 'type',
    }),
  ],
});

function contextWith(table, writtenValue = {}, localPaths = new Map()) {
  return mergeContextOf({ ...parsedDsl(mergedEntry), dir: '/repo' }, table, { writtenValue, localPaths });
}

test('a merge call among its map\'s keys merges its contents in order, the map\'s own keys over them', () => {
  const written = {
    locals: { mock_defaults: { size: 1, logs: { enabled: true } }, mock_other: { size: 2, mode: 'slow' } },
    mocktype: {
      shallow: { 'fn.merge*': ['local.mock_defaults', 'local.mock_other'], logs: { group: 'mock-group' } },
    },
  };
  const localPaths = new Map([
    ['mock_defaults', ['locals', 'mock_defaults']],
    ['mock_other', ['locals', 'mock_other']],
  ]);
  const shallow = mergedValueOf(written, contextWith({ merge: mergeMacro('shallow') }, written, localPaths));
  assert.deepEqual(shallow.value.mocktype.shallow, { size: 2, mode: 'slow', logs: { group: 'mock-group' } });
  assert.equal(preMergePathOf(shallow.pathMap, ['mocktype', 'shallow', 'size']).join('.'), 'mocktype.shallow.fn.merge*');
  assert.deepEqual(preMergePathOf(shallow.pathMap, ['mocktype', 'shallow', 'logs']), ['mocktype', 'shallow', 'logs']);
  const deep = mergedValueOf(written, contextWith({ merge: mergeMacro('deep') }, written, localPaths));
  assert.deepEqual(deep.value.mocktype.shallow.logs, { enabled: true, group: 'mock-group' });
  const join = mergedValueOf(written, contextWith({ merge: mergeMacro('join') }, written, localPaths));
  assert.deepEqual(join.problems, [
    { path: ['mocktype', 'shallow', 'fn.merge*'], message: '`size` is set twice in a join' },
    { path: ['mocktype', 'shallow', 'fn.merge*'], message: '`logs` is set twice in a join' },
  ]);
});

test('a content that is not a local\'s map supplies the holding map\'s requirements, and a call standing alone '
  + 'is the function of its name', () => {
  const written = {
    mocktype: {
      unknown: { 'fn.merge*': ['ref mock_source.config'], mode: 'fast' },
      missing_local: { 'fn.merge': 'local.mock_absent' },
      inline: { 'fn.merge': { size: 3 } },
    },
  };
  const merged = mergedValueOf(written, contextWith({ merge: mergeMacro('shallow') }));
  assert.deepEqual([...merged.requirementsSuppliedAt].sort(), [
    JSON.stringify(['mocktype', 'missing_local']),
    JSON.stringify(['mocktype', 'unknown']),
  ]);
  assert.deepEqual(merged.value.mocktype.unknown, { mode: 'fast' });
  assert.deepEqual(merged.value.mocktype.inline, { size: 3 });
  const mergeFunction = {
    description: 'Mock merge function.',
    arguments: [{ name: 'maps', type: 'map', required: true, repeated: true, description: 'The mock maps.' }],
    return: { type: 'map', description: 'The mock merged map.' },
    macro: null,
  };
  const both = unitedTableOf([{ merge: mergeFunction }, { merge: mergeMacro('shallow') }]);
  assert.equal(calledEntryOf(both, 'merge').entry.macro, null);
  assert.equal(calledEntryOf(both, 'merge', true).entry.macro.kind, 'merge');
  assert.deepEqual(tableEntriesOf(both).map(([name, entry]) => [name, tableEntryKindOf(entry)]), [
    ['merge', 'function'],
    ['merge', 'macro'],
  ]);
  assert.equal(calledEntryOf(unitedTableOf([{ merge: mergeMacro('shallow') }, { merge: mergeFunction }]), 'merge', true)
    .entry.macro.kind, 'merge');
  const positioned = mergedValueOf({
    alone: { 'fn.merge': { size: 3 } },
    among: { 'fn.merge': { size: 3 }, mode: 'fast' },
  }, contextWith(both));
  assert.deepEqual(positioned.value, { alone: { 'fn.merge': { size: 3 } }, among: { size: 3, mode: 'fast' } });
});

const schema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  'x-yaml-dsl-functions': {
    merge: {
      description: 'Merges the mock contents.',
      arguments: [{ name: 'contents', type: 'map', required: true, repeated: true, description: 'The mock contents.' }],
      macro: { kind: 'merge', content: 'contents', merge_behavior: 'shallow' },
    },
  },
  type: 'object',
  properties: {
    locals: { type: 'object' },
    mocktype: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['size'],
        properties: {
          size: { type: 'integer', description: '[required] Mock size.' },
          mode: { enum: ['fast', 'slow'], description: '[optional] Mock mode.' },
        },
      },
    },
  },
});

const root = '/repo/mock-stack';
const common = `${root}/mock.yml`;
const one = `${root}/one/mock.yml`;
const files = {
  [`${root}/schema.json`]: schema,
  [common]: [
    'locals:',
    '  mock_defaults:',
    '    size: 1',
    'mocktype:',
    '  shared:',
    '    fn.merge: local.mock_defaults',
    '',
  ].join('\n'),
  [one]: [
    'locals:',
    '  mock_wrong:',
    '    size: large',
    'mocktype:',
    '  own:',
    '    fn.merge: local.mock_wrong',
    '    mode: fast',
    '  unknown:',
    '    fn.merge*:',
    '      - ref mock_source.config',
    '      - local.mock_defaults',
    '  missing:',
    '    mode: fast',
    '',
  ].join('\n'),
};

test('a merge reads a local from the overlay or the common layer, validates what it merges at the call, '
  + 'and lets a content known only at use supply required fields', async () => {
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(mergedEntry), dir: '/repo' }]);
  for (const filePath of [common, one]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  await ws.setActive(one);
  await ws.setActive(null);
  const validationMessages = (filePath) => ws.problems(`file://${filePath}`)
    .filter((problem) => problem.kind === 'validationError')
    .map((problem) => [problem.range.start.line, problem.message]);
  assert.deepEqual(validationMessages(one), [
    [5, '`size` must be integer'],
    [11, '`size` is required'],
  ]);
  assert.deepEqual(validationMessages(common), []);
});

const landingEntry = dslEntry('landing', {
  ...mergedEntry,
  id: 'landing',
  declarations: [
    declaration('$.locals.*', 'local'),
    declaration('$.*.*', 'ENTRY', { skip_keys: ['locals'] }),
  ],
});

const landingFiles = {
  [`${root}/schema.json`]: schema,
  [common]: [
    'locals:',
    '  mock_shared:',
    '    fn.merge: local.mock_nested',
    '    first:',
    '      size: 1',
    '  mock_nested:',
    '    second:',
    '      size: 2',
    '  mock_cycle:',
    '    fn.merge: local.mock_cycle',
    'mocktype:',
    '  fn.merge*:',
    '    - local.mock_shared',
    '    - local.mock_cycle',
    '  own:',
    '    size: 3',
    'mockuser:',
    '  common_uses: ref mocktype.first',
    '',
  ].join('\n'),
  [one]: [
    'locals:',
    '  mock_nested:',
    '    third:',
    '      size: 5',
    'mockuser:',
    '  uses:',
    '    - ref mocktype.first',
    '    - ref mocktype.third',
    '    - ref mocktype.second',
    '',
  ].join('\n'),
};

function lineAt(text, needle) {
  return text.slice(0, text.indexOf(needle)).split('\n').length - 1;
}

function positionAt(text, needle) {
  const index = text.indexOf(needle);
  return { line: lineAt(text, needle), character: index - text.lastIndexOf('\n', index - 1) - 1 };
}

test('a merge declares the names its local contents hold where it lands, through nested merges and the fold\'s locals',
  async () => {
    const ws = createWorkspace({
      readFile: async (filePath) => (Object.hasOwn(landingFiles, filePath) ? landingFiles[filePath] : null),
      fetchText: async () => null,
    });
    await ws.setConfigs([{ text: configText(landingEntry), dir: '/repo' }]);
    for (const filePath of [common, one]) await ws.sync(`file://${filePath}`, filePath, landingFiles[filePath]);
    const definitionOf = (filePath, needle) => {
      const found = ws.definition(`file://${filePath}`, positionAt(landingFiles[filePath], needle));
      return found ? [found.path, found.range.start.line] : null;
    };
    assert.deepEqual(definitionOf(common, 'ref mocktype.first'), [common, lineAt(landingFiles[common], 'first:')]);
    assert.deepEqual(definitionOf(one, 'ref mocktype.first'), [common, lineAt(landingFiles[common], 'first:')]);
    assert.deepEqual(definitionOf(one, 'ref mocktype.third'), [one, lineAt(landingFiles[one], 'third:')]);
    assert.equal(definitionOf(one, 'ref mocktype.second'), null);
    assert.deepEqual(ws.references(`file://${one}`).map((found) => found.kind), ['external', 'local', 'error']);
    const typed = landingFiles[one].replace('ref mocktype.second', 'ref mocktype.');
    await ws.sync(`file://${one}`, one, typed);
    const typedAt = positionAt(typed, 'ref mocktype.\n');
    const typedEnd = { ...typedAt, character: typedAt.character + 'ref mocktype.'.length };
    const offered = ws.completion(`file://${one}`, typedEnd).map((item) => item.label);
    assert.deepEqual(offered.filter((label) => label.startsWith('ref mocktype.')).sort(), [
      'ref mocktype.first',
      'ref mocktype.own',
      'ref mocktype.third',
    ]);
  });

test('a deep merge declares the nested names of every content, with each name in the file that writes it', () => {
  const localsPath = '/repo/mock-locals.yml';
  const holdingPath = '/repo/mock.yml';
  const localsText = [
    'locals:',
    '  mock_base:',
    '    shared:',
    '      first: 1',
    '    tags:',
    '      - mock-tag',
    '',
  ].join('\n');
  const holdingText = [
    'mocktype:',
    '  fn.merge*:',
    '    - local.mock_base',
    '    - inline: 1',
    '  shared:',
    '    second: 2',
    '',
  ].join('\n');
  const parsedFiles = new Map([
    [localsPath, { text: localsText, tree: parseYaml(localsText).tree }],
    [holdingPath, { text: holdingText, tree: parseYaml(holdingText).tree }],
  ]);
  const dsl = parsedDsl(dslEntry('nested', {
    function: markerFunction({ definitions: ['schema'] }),
    locals: { scope_name: 'local' },
    scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
    declarations: [
      declaration('$.locals.*', 'local'),
      declaration('$.mocktype.*', 'ENTRY'),
      declaration('$.mocktype.shared.*', 'ENTRY'),
      declaration('$.mocktype.tags.*', 'ENTRY', { name_source: 'value' }),
    ],
    references: [reference('^local\\.(?<name>[a-z0-9_]+)$', 'local')],
  }));
  const localSymbols = new Map([['mock_base', { file: localsPath, documentPath: ['locals', 'mock_base'] }]]);
  const declaredWith = (mergeBehavior) => {
    const context = mergeTreeContextOf(dsl, { merge: mergeMacro(mergeBehavior) }, {
      localSymbols,
      fileOf: (filePath) => parsedFiles.get(filePath),
    });
    const tree = mergedTreeOf(parsedFiles.get(holdingPath).tree, context);
    return collectSymbols(tree, dsl, holdingPath, holdingText)
      .map((symbol) => [symbol.name, symbol.file, symbol.keyRange.start.line]);
  };
  assert.deepEqual(declaredWith('deep'), [
    ['shared', holdingPath, 4],
    ['tags', localsPath, 4],
    ['inline', holdingPath, 3],
    ['first', localsPath, 3],
    ['second', holdingPath, 5],
    ['mock-tag', localsPath, 5],
  ]);
  assert.deepEqual(declaredWith('shallow').filter(([name]) => name === 'first'), []);
});

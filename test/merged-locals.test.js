const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { mergeTargetTermsOf } = require('../lib/merge-target-terms');
const {
  scope,
  declaration,
  reference,
  markerFunction,
  dslEntry,
  configText,
} = require('./config-builders');

const mergingEntry = dslEntry('merging', {
  file_includes: ['**/mock.yml'],
  schema_search_paths: ['.schema/sample.schema.json'],
  layers: {
    overlay_folders: ['one', 'two'],
    common_layer_discovery: 'ancestor',
    duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
  },
  function: markerFunction({ definitions: ['schema'] }),
  locals: { scope_name: 'local' },
  scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
  declarations: [declaration('$.locals.*', 'local'), declaration('$.*.*', 'ENTRY', { skip_keys: ['locals'] })],
  references: [reference('^local\\.(?<name>[a-z0-9_]+)$', 'local')],
});

const labelField = { type: 'string', description: '[optional] Mock label.' };

const schemaWith = (sizeDescription) => JSON.stringify({
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
        properties: {
          size: { type: 'integer', description: sizeDescription },
          mode: { enum: ['fast', 'slow'], description: '[optional] Mock mode.' },
          label: labelField,
        },
      },
    },
    topictype: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          size: { type: 'string', description: '[optional] Mock topic size.' },
          label: labelField,
        },
      },
    },
  },
});

const root = '/repo/mock-stack';
const common = `${root}/mock.yml`;
const one = `${root}/one/mock.yml`;
const two = `${root}/two/mock.yml`;
const files = {
  [`${root}/one/.schema/sample.schema.json`]: schemaWith('[required] Mock size.'),
  [`${root}/two/.schema/sample.schema.json`]: schemaWith('[required] Mock size, in two.'),
  [common]: [
    'locals:',
    '  mock_defaults:',
    '    size: 1',
    '    label: mock-label',
    'mocktype:',
    '  first:',
    '    fn.merge: local.mock_defaults',
    '  second:',
    '    fn.merge: local.mock_defaults',
    '',
  ].join('\n'),
  [one]: [
    'topictype:',
    '  alerts:',
    '    fn.merge: local.mock_defaults',
    '',
  ].join('\n'),
  [two]: [
    'locals:',
    '  mock_own:',
    '    size: 3',
    'mocktype:',
    '  third:',
    '    fn.merge: local.mock_own',
    '    mode: fast',
    '',
  ].join('\n'),
};

function positionAt(text, needle, shift = 0) {
  const index = text.indexOf(needle) + shift;
  return {
    line: text.slice(0, index).split('\n').length - 1,
    character: index - text.lastIndexOf('\n', index - 1) - 1,
  };
}

function headingOf(text) {
  const joined = [...text].join('⁠').replace(/⁠,⁠ ⁠/g, ', ');
  const color = 'var(--vscode-yamlDslEditor-dark-overlayHeadingForeground)';
  return `<span style="color:${color};"><strong>${joined}</strong></span>`;
}

async function mergingWorkspace(entry = mergingEntry, terraformFunctions = async () => null) {
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
    terraformFunctions,
  });
  ws.vocabularyLoaded = new Promise((resolve) => { ws.onVocabularyLoaded(resolve); });
  await ws.setConfigs([{ text: configText(entry), dir: '/repo' }]);
  for (const filePath of [common, one, two]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  for (const filePath of [common, one, two]) await ws.setActive(filePath);
  await ws.setActive(null);
  return ws;
}

test('merge target terms group the overlays merging at the same paths and factor out the paths\' common prefix', () => {
  assert.deepEqual(mergeTargetTermsOf([
    { label: 'dev', path: ['queue', 'orders'] },
    { label: 'dev', path: ['queue', 'payments'] },
    { label: 'prod', path: ['queue', 'orders'] },
    { label: 'prod', path: ['queue', 'payments'] },
    { label: 'staging', path: ['queue', 'orders'] },
    { label: 'staging', path: ['topic', 'alerts'] },
    { label: 'staging', path: ['queue', 'orders'] },
  ]), ['{dev,prod}:queue.{orders,payments}', 'staging:{queue.orders,topic.alerts}']);
  assert.deepEqual(mergeTargetTermsOf([{ label: null, path: ['queue', 'orders'] }]), ['queue.orders']);
});

test('a key in a local the common layer merges is documented by every schema it lands under, a section per '
  + 'documentation, and completes the fields every schema shares', async () => {
  const ws = await mergingWorkspace();
  const hover = ws.hover(`file://${common}`, positionAt(files[common], 'size', 1));
  assert.equal(hover.contents.value, [
    `${headingOf('one:mocktype.{first,second}')}\n\n\`size\`: *integer*    \`[required]\`\n\nMock size.`,
    `${headingOf('one:topictype.alerts')}\n\n\`size\`: *string*    \`[optional]\`\n\nMock topic size.`,
    `${headingOf('two:mocktype.{first,second}')}\n\n\`size\`: *integer*    \`[required]\`\n\nMock size, in two.`,
  ].join('\n\n'));
  const typed = files[common].replace('    label: mock-label\n', '    label: mock-label\n    \n');
  await ws.sync(`file://${common}`, common, typed);
  const offered = ws.completion(`file://${common}`, positionAt(typed, '    \nmocktype', 4)).map((item) => item.label);
  assert.deepEqual(offered.filter((label) => ['size', 'mode', 'label'].includes(label)), ['label']);
});

test('a reference to a local only the common layer declares goes to that one declaration in every fold', async () => {
  const ws = await mergingWorkspace();
  const referenceAtFirst = positionAt(files[common], 'local.mock_defaults', 2);
  const definition = ws.definition(`file://${common}`, referenceAtFirst);
  assert.equal(definition.path, common);
  assert.deepEqual(definition.range.start, { line: 1, character: 2 });
  const hover = ws.hover(`file://${common}`, referenceAtFirst);
  assert.equal(hover.contents.value.match(/```yaml-dsl/g).length, 1);
});

test('a key in a local a stack with no overlay files merges by lone calls, Terraform\'s merge declared before the '
  + 'schema\'s, reads the stack\'s one schema', async () => {
  const loneRoot = '/repo/mock-lone';
  const lone = `${loneRoot}/mock.yml`;
  const loneText = files[common];
  const loneFiles = { [`${loneRoot}/.schema/sample.schema.json`]: schemaWith('[required] Mock size.'), [lone]: loneText };
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(loneFiles, filePath) ? loneFiles[filePath] : null),
    fetchText: async () => null,
    terraformFunctions: async () => ({
      function_signatures: { merge: { description: 'Mock merge.', return_type: 'dynamic', parameters: [] } },
    }),
  });
  ws.vocabularyLoaded = new Promise((resolve) => { ws.onVocabularyLoaded(resolve); });
  const withTerraform = { ...mergingEntry, function: markerFunction({ definitions: ['terraform', 'schema'] }) };
  await ws.setConfigs([{ text: configText(withTerraform), dir: '/repo' }]);
  await ws.sync(`file://${lone}`, lone, loneText);
  await ws.setActive(lone);
  await ws.vocabularyLoaded;
  await ws.whenAnalyzed(`file://${lone}`);
  const hover = ws.hover(`file://${lone}`, positionAt(loneText, 'size', 1));
  assert.equal(hover.contents.value, '`size`: *integer*    `[required]`\n\nMock size.');
});

test('a key in a local an overlay merges reads that overlay\'s one schema', async () => {
  const ws = await mergingWorkspace();
  const hover = ws.hover(`file://${two}`, positionAt(files[two], 'size', 1));
  assert.equal(hover.contents.value, '`size`: *integer*    `[required]`\n\nMock size, in two.');
  const typed = files[two].replace('    size: 3\n', '    size: 3\n    \n');
  await ws.sync(`file://${two}`, two, typed);
  const offered = ws.completion(`file://${two}`, positionAt(typed, '    \nmocktype', 4)).map((item) => item.label);
  assert.deepEqual(offered.filter((label) => ['size', 'mode', 'label'].includes(label)), ['size', 'mode', 'label']);
});

test('a merge macro beside a Terraform function of its name still documents the locals it merges', async () => {
  const withTerraform = { ...mergingEntry, function: markerFunction({ definitions: ['terraform', 'schema'] }) };
  const terraformMerge = async () => ({
    function_signatures: { merge: { description: 'Mock merge.', return_type: 'dynamic', parameters: [] } },
  });
  const ws = await mergingWorkspace(withTerraform, terraformMerge);
  await ws.vocabularyLoaded;
  await ws.whenAnalyzed(`file://${two}`);
  const hover = ws.hover(`file://${two}`, positionAt(files[two], 'size', 1));
  assert.equal(hover.contents.value, '`size`: *integer*    `[required]`\n\nMock size, in two.');
});

test('a common layer with no schema of its own checks its calls against each overlay\'s function table', async () => {
  const tableRoot = '/repo/mock-tables';
  const tableCommon = `${tableRoot}/mock.yml`;
  const withOnlyFunction = (description) => {
    const parsed = JSON.parse(schemaWith(description));
    parsed['x-yaml-dsl-functions'].only_one = {
      description: 'Mock function only overlay one publishes.',
      arguments: [{ name: 'value', type: 'text', required: true, repeated: false, description: 'The mock value.' }],
      return: { type: 'text', description: 'The mock result.' },
    };
    return JSON.stringify(parsed);
  };
  const commonText = [
    'locals:',
    '  mock_defaults:',
    '    size: 1',
    '  mock_label fn.only_one: mock-value',
    'mocktype:',
    '  first:',
    '    fn.merge: local.mock_defaults',
    '    mode: fast',
    '',
  ].join('\n');
  const tableFiles = {
    [`${tableRoot}/one/.schema/sample.schema.json`]: withOnlyFunction('[required] Mock size.'),
    [`${tableRoot}/two/.schema/sample.schema.json`]: schemaWith('[required] Mock size.'),
    [tableCommon]: commonText,
    [`${tableRoot}/one/mock.yml`]: 'mocktype: {}\n',
    [`${tableRoot}/two/mock.yml`]: 'mocktype: {}\n',
  };
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(tableFiles, filePath) ? tableFiles[filePath] : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(mergingEntry), dir: '/repo' }]);
  for (const filePath of Object.keys(tableFiles).filter((filePath) => filePath.endsWith('mock.yml'))) {
    await ws.sync(`file://${filePath}`, filePath, tableFiles[filePath]);
  }
  await ws.setActive(tableCommon);
  const callProblemsOf = () => ws.problems(`file://${tableCommon}`)
    .filter((problem) => /function|only key/.test(problem.message))
    .map((problem) => [problem.range.start.line, problem.message]);
  assert.deepEqual(callProblemsOf(), [[3, 'unknown function only_one (two)']]);
});

test('a fold merging one local into maps with different schemas is an error at each merge call', async () => {
  const ws = await mergingWorkspace();
  const mergeProblemsOf = (filePath) => ws.problems(`file://${filePath}`)
    .filter((problem) => problem.message.includes('different schemas'))
    .map((problem) => [problem.range.start.line, problem.message]);
  const commonMessage = '`local.mock_defaults` is merged into maps with different schemas: '
    + '`one:mocktype.{first,second}` and `one:topictype.alerts`';
  assert.deepEqual(mergeProblemsOf(common), [[6, commonMessage], [8, commonMessage]]);
  assert.deepEqual(mergeProblemsOf(one), [[2, '`local.mock_defaults` is merged into maps with different schemas: '
    + '`mocktype.{first,second}` and `topictype.alerts`']]);
  assert.deepEqual(mergeProblemsOf(two), []);
});

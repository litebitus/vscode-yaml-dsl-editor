const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const {
  scope,
  declaration,
  reference,
  placeholder,
  markerFunction,
  dslEntry,
  configText,
} = require('./config-builders');

const loopBodyKeysEntry = dslEntry('loop-body-keys', {
  file_includes: ['**/mock.yml'],
  schema_search_paths: ['{config_root}/mock.schema.json'],
  placeholder: placeholder(),
  function: markerFunction({ definitions: ['schema'] }),
  locals: { scope_name: 'local' },
  loops: { scope_name: 'LOOP' },
  scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }), LOOP: scope() },
  declarations: [
    declaration('$.locals.*', 'local'),
    declaration('$.*.*', 'ENTRY', { skip_keys: ['locals'] }),
  ],
  references: [
    reference('^local\\.(?<name>[a-z0-9_]+)', 'local', { text_after_name_allowed: true }),
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', 'ENTRY', {
      text_after_name_allowed: true,
      scope_group: 'type',
    }),
    reference('^(?<name>[a-z_]+)$', 'LOOP', { positions: ['whole_placeholder', 'placeholder_in_text'] }),
  ],
});

const entriesSchema = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    additionalProperties: false,
    required: ['size'],
    properties: { size: { type: 'integer' }, source: { type: 'string' } },
  },
};

const mockSchemaText = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  'x-yaml-dsl-functions': {
    for_each: {
      description: 'Repeats the mock body.',
      arguments: [
        { name: 'variable', type: 'text', required: true, repeated: false, description: 'Mock variable.' },
        { name: 'items', type: 'any', required: true, repeated: false, description: 'Mock items.' },
        { name: 'body', type: 'map', required: true, repeated: false, description: 'Mock body.' },
      ],
      macro: { kind: 'loop', loop_variables: 'variable', collection: 'items', body: 'body' },
    },
  },
  type: 'object',
  properties: { locals: { type: 'object' }, mocktype: entriesSchema, othertype: entriesSchema },
});

const common = '/repo/mock-stack/mock.yml';
const commonUri = `file://${common}`;
const commonText = [
  'locals:',
  '  mock_names:',
  '    - mock_a',
  '    - mock_b',
  'mocktype:',
  '  fn.for_each:',
  '    variable: name',
  '    items: local.mock_names',
  '    body:',
  '      ${name}_queue:',
  '        size: 1',
  '      mock_shared:',
  '        size: 2',
  '  mock_user:',
  '    size: 3',
  '    source: ref mocktype.mock_shared',
  'othertype:',
  '  fn.for_each:',
  '    variable: name',
  '    items: ref mocktype.mock_a_queue',
  '    body:',
  '      ${name}_topic:',
  '        size: 1',
  '      mock_fixed:',
  '        size: 2',
  '  mock_user:',
  '    size: 3',
  '    source: ref othertype.mock_fixed',
  '',
].join('\n');

let ws;

test.beforeEach(async () => {
  ws = createWorkspace({
    readFile: async (filePath) => {
      if (filePath === common) return commonText;
      return filePath === '/repo/mock.schema.json' ? mockSchemaText : null;
    },
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(loopBodyKeysEntry), dir: '/repo' }]);
  await ws.sync(commonUri, common, commonText);
});

test.afterEach(() => {
  ws.close(commonUri);
  ws.dispose();
  ws = null;
});

test('a loop body\'s key that reads no loop variable is a macro warning at the key, '
  + 'whether the loop\'s items are known or left to when the document is used, '
  + 'and the stack\'s report flags the file holding one', async () => {
  await ws.whenValidated();
  const problems = ws.problems(commonUri)
    .map((problem) => [problem.range.start.line, problem.severity, problem.kind, problem.message]);
  const sameKeyMessage = (key) => `the loop body's key \`${key}\` reads no loop variable, `
    + 'so every pass writes the same key';
  assert.deepEqual(problems, [
    [11, 'warning', 'macroWarning', sameKeyMessage('mock_shared')],
    [23, 'warning', 'macroWarning', sameKeyMessage('mock_fixed')],
  ]);
  const report = ws.suggestionMarks(common);
  assert.deepEqual(report.files.map((file) => [file.uri, file.warningKinds]), [[commonUri, ['macroWarning']]]);
});

test('a loop body\'s key that reads no loop variable declares no name, '
  + 'while a sibling that reads one declares each name it spells', () => {
  const kindsByLine = new Map(ws.references(commonUri).map((ref) => [ref.range.start.line, ref.kind]));
  assert.equal(kindsByLine.get(15), 'error');
  assert.equal(kindsByLine.get(19), 'local');
  assert.equal(kindsByLine.get(27), 'error');
});

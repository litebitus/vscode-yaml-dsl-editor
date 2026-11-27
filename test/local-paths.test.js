const test = require('node:test');
const assert = require('node:assert/strict');
const { createVirtualWorkspace } = require('./virtual-document-schemas');
const {
  scope,
  declaration,
  reference,
  placeholder,
  markerFunction,
  dslEntry,
  configText,
} = require('./config-builders');

const pathedEntry = dslEntry('pathed', {
  file_includes: ['**/mock.yml'],
  schema_search_paths: ['{config_root}/mock-stack/schema.json'],
  placeholder: placeholder(),
  function: markerFunction({ definitions: ['schema'] }),
  locals: { scope_name: 'local', path_separator: '.' },
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

const mockArgument = (name, type) => ({ name, type, required: true, repeated: false, description: `Mock ${name}.` });

const schema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  'x-yaml-dsl-functions': {
    merge: {
      description: 'Merges the mock contents.',
      arguments: [{ ...mockArgument('contents', 'map'), repeated: true }],
      macro: { kind: 'merge', content: 'contents', merge_behavior: 'shallow' },
    },
    for_each: {
      description: 'Repeats the mock body.',
      arguments: [mockArgument('variable', 'text'), mockArgument('items', 'list'), mockArgument('body', 'map')],
      macro: { kind: 'loop', loop_variables: 'variable', collection: 'items', body: 'body' },
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
          label: { type: 'string', description: '[optional] Mock label.' },
          source: { type: 'string', description: '[optional] Mock source.' },
        },
      },
    },
  },
});

const root = '/repo/mock-stack';
const common = `${root}/mock.yml`;
const commonText = [
  'locals:',
  '  defaults:',
  '    queue:',
  '      size: 1',
  '    names:',
  '      - alpha',
  '      - beta',
  '  alias: local.defaults',
  '  composed:',
  '    fn.merge: local.defaults',
  '  unknowable: ref mocktype.first',
  '  queue_alias:',
  '    fn.merge: local.defaults.queue',
  'mocktype:',
  '  first:',
  '    fn.merge: local.defaults.queue',
  '    label: local.defaults.names.1',
  '  second:',
  '    fn.merge: local.alias.queue',
  '    source: ref mocktype.gamma_queue',
  '  missing:',
  '    fn.merge: local.defaults.queues',
  '    label: local.defaults.names.5',
  '  third:',
  '    fn.merge: local.composed.queue',
  '    label: local.unknowable.name',
  '  fourth:',
  '    fn.merge: local.queue_alias',
  '  fn.for_each:',
  '    variable: name',
  '    items: local.defaults.names',
  '    body:',
  '      ${name}_queue:',
  '        size: 2',
  '        source: ref mocktype.beta_queue',
  '',
].join('\n');

function positionAt(text, needle, shift = 0) {
  const index = text.indexOf(needle) + shift;
  return {
    line: text.slice(0, index).split('\n').length - 1,
    character: index - text.lastIndexOf('\n', index - 1) - 1,
  };
}

async function pathedWorkspace() {
  const files = { [`${root}/schema.json`]: schema, [common]: commonText };
  const ws = createVirtualWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(pathedEntry), dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, commonText);
  await ws.setActive(common);
  await ws.setActive(null);
  return ws;
}

test('a reference into a local reads the value at its path, through other locals, and a step the value lacks is an '
  + 'error naming what holds it', async () => {
  const ws = await pathedWorkspace();
  const hover = ws.hover(`file://${common}`, positionAt(commonText, 'local.defaults.queue', 2)).contents.value;
  assert.match(hover, /mock\.yml:3\]/);
  assert.match(hover, /```yaml-dsl\n {4}queue:\n {6}size: 1\n```/);
  const pathDefinition = ws.definition(`file://${common}`, positionAt(commonText, 'local.defaults.queue', 2));
  assert.equal(pathDefinition.range.start.line, 2);
  assert.equal(ws.hover(`file://${common}`, positionAt(commonText, 'local.defaults.queues', 2)), null);
  assert.equal(ws.definition(`file://${common}`, positionAt(commonText, 'local.defaults.queues', 2)), null);
  const problems = ws.problems(`file://${common}`).map((problem) => [problem.range.start.line, problem.message]);
  assert.deepEqual(problems, [
    [21, '`local.defaults` holds no `queues`'],
    [22, '`local.defaults.names` holds no `5`'],
  ]);
  const kinds = ws.references(`file://${common}`).map((found) => [found.range.start.line, found.kind]);
  assert.deepEqual(kinds.filter(([line]) => [15, 16, 18, 21, 24, 25].includes(line)), [
    [15, 'local'],
    [16, 'local'],
    [18, 'local'],
    [21, 'error'],
    [24, 'local'],
    [25, 'local'],
  ]);
});

test('a loop over a list a local holds repeats its body once per item of the list', async () => {
  const ws = await pathedWorkspace();
  const definitionLineOf = (needle) => {
    const found = ws.definition(`file://${common}`, positionAt(commonText, needle, 4));
    return found ? found.range.start.line : null;
  };
  assert.equal(definitionLineOf('ref mocktype.beta_queue'), positionAt(commonText, '${name}_queue').line);
  assert.equal(definitionLineOf('ref mocktype.gamma_queue'), null);
  const kinds = ws.references(`file://${common}`).map((found) => [found.range.start.line, found.kind]);
  assert.deepEqual(kinds.filter(([line]) => line === 19), [[19, 'error']]);
});

const calledLocalsEntry = dslEntry('called', {
  file_includes: ['**/mock.yml'],
  schema_search_paths: ['{config_root}/mock-called/schema.json'],
  placeholder: placeholder(),
  function: markerFunction({ definitions: ['schema'] }),
  locals: { scope_name: 'local', path_separator: '.' },
  scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
  declarations: [
    declaration('$.locals.*', 'local', { key_token: 'first_word' }),
    declaration('$.*.*', 'ENTRY', { skip_keys: ['locals'] }),
  ],
  references: [reference('^local\\.(?<name>[a-z0-9_]+)', 'local', { text_after_name_allowed: true })],
});

const calledLocalsSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  'x-yaml-dsl-functions': {
    decode: { description: 'Decodes the mock text.', arguments: [mockArgument('text', 'text')] },
    read: { description: 'Reads the mock file.', arguments: [mockArgument('path', 'text')] },
    concat: {
      description: 'Joins the mock lists.',
      arguments: [{ ...mockArgument('lists', 'list'), repeated: true }],
    },
  },
  type: 'object',
});

const calledRoot = '/repo/mock-called';
const calledFile = `${calledRoot}/mock.yml`;
const calledText = [
  'locals:',
  '  policy fn.decode:',
  '    fn.read: mock-policy.yml',
  '  defaults:',
  '    branches fn.concat*:',
  '      - [mock-a]',
  '      - [mock-b]',
  'mocktype:',
  '  first:',
  '    branches: local.policy.branches',
  '    joined: local.defaults.branches',
  '    item: local.defaults.branches.0',
  '    absent: local.defaults.missing',
  '',
].join('\n');

test('a path into a value a call gives, a local declared by a call or a key holding one, is known only when the '
  + 'document is used, and a step the value lacks beside it is still an error', async () => {
  const files = { [`${calledRoot}/schema.json`]: calledLocalsSchema, [calledFile]: calledText };
  const ws = createVirtualWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(calledLocalsEntry), dir: '/repo' }]);
  await ws.sync(`file://${calledFile}`, calledFile, calledText);
  const problems = ws.problems(`file://${calledFile}`).map((problem) => [problem.range.start.line, problem.message]);
  assert.deepEqual(problems, [[12, '`local.defaults` holds no `missing`']]);
  const joined = ws.definition(`file://${calledFile}`, positionAt(calledText, 'local.defaults.branches', 2));
  assert.equal(joined.range.start.line, 4);
  const kinds = ws.references(`file://${calledFile}`).map((found) => [found.range.start.line, found.kind]);
  assert.deepEqual(kinds, [[9, 'local'], [10, 'local'], [11, 'local'], [12, 'error']]);
});

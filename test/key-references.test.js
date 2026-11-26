const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { scope, declaration, reference, placeholder, dslEntry, configText } = require('./config-builders');

const inPlaceholders = ['whole_placeholder', 'placeholder_in_text'];

const keyReferencesEntry = dslEntry('key-references', {
  file_includes: ['**/mock.yml'],
  schema_search_paths: ['{config_root}/mock.schema.json'],
  placeholder: placeholder(),
  locals: { scope_name: 'local', path_separator: '.' },
  scopes: {
    GLOBAL: scope({ builtin_names: ['env'] }),
    local: scope(),
    ENTRY: scope({ named_by_parent_key: true }),
  },
  declarations: [
    declaration('$.locals.*', 'local'),
    declaration('$.*.*', 'ENTRY', {
      skip_keys: ['locals', 'strict'],
      key_token: 'last_word',
      name_spelling: 'dashes_as_underscores',
    }),
  ],
  references: [
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>(?:[a-z0-9_]|\\$\\{[a-z][a-z0-9_.]*\\})+)', 'ENTRY', {
      text_after_name_allowed: true,
      scope_group: 'type',
    }),
    reference('^local\\.(?<name>[a-z0-9_]+)(?=$|\\.)', 'local', {
      positions: ['whole_scalar', ...inPlaceholders],
      text_after_name_allowed: true,
    }),
    reference('^(?<name>[a-z_]+)$', 'GLOBAL', { positions: inPlaceholders }),
  ],
});

const mockSchemaText = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    locals: { type: 'object' },
    mocktype: { type: 'object', additionalProperties: { $ref: '#/$defs/entry' } },
    strict: {
      type: 'object',
      required: ['mock_required'],
      properties: { mock_required: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  $defs: {
    entry: {
      type: 'object',
      required: ['size'],
      properties: { size: { type: 'integer' }, labels: { type: 'object' } },
      additionalProperties: false,
    },
  },
});

const root = '/repo/mock-stack';
const common = `${root}/mock.yml`;
const commonUri = `file://${common}`;
const commonText = [
  'locals:',
  '  mock_id: mock',
  '  mock_target: ref mocktype.mock_primary',
  'mocktype:',
  '  mock_primary:',
  '    size: 1',
  '  ref mocktype.mock_primary:',
  '    size: mock-one',
  '  ref mocktype.mock_missing:',
  '    size: 1',
  '  name ${local.mock_target}:',
  '    size: mock-one',
  '  name ${local.mock_id}-api:',
  '    size: 1',
  '  name ${env}-socket:',
  '    size: mock-one',
  '  mock_user:',
  '    size: 1',
  '    labels:',
  '      ref mocktype.mock_api: mock-label',
  '      mock_deferred: ref mocktype.${local.mock_target}',
  'strict:',
  '  ref mocktype.mock_primary: 1',
  '  mock_unknown: 1',
  '',
].join('\n');

function positionAt(text, needle, offset = 0) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(needle);
  const at = index + offset;
  return {
    line: text.slice(0, at).split('\n').length - 1,
    character: at - text.lastIndexOf('\n', at - 1) - 1,
  };
}

let ws;

test.beforeEach(async () => {
  ws = createWorkspace({
    readFile: async (filePath) => {
      if (filePath === common) return commonText;
      return filePath === '/repo/mock.schema.json' ? mockSchemaText : null;
    },
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(keyReferencesEntry), dir: '/repo' }]);
  await ws.sync(commonUri, common, commonText);
});

test.afterEach(() => {
  ws.close(commonUri);
  ws.dispose();
  ws = null;
});

test('a reference that is a whole key goes to its declaration, and one nothing declares is an error', () => {
  const found = ws.definition(commonUri, positionAt(commonText, 'ref mocktype.mock_primary:', 'ref '.length));
  assert.equal(found.range.start.line, 4);
  const keyLines = ws.references(commonUri)
    .filter((ref) => [6, 8, 19, 22].includes(ref.range.start.line))
    .map((ref) => [ref.range.start.line, ref.range.start.character, ref.kind]);
  assert.deepEqual(keyLines, [[6, 2, 'local'], [8, 2, 'error'], [19, 6, 'local'], [22, 2, 'local']]);
  const hover = ws.hover(commonUri, positionAt(commonText, 'ref mocktype.mock_missing', 'ref '.length));
  assert.match(hover.contents.value, /^Invalid reference: mocktype/);
});

test('a deferred key declares no name, and a resolved key holding a placeholder does', async () => {
  const definitionLine = (needle) => {
    const found = ws.definition(commonUri, positionAt(commonText, needle, 'ref '.length));
    return found ? found.range.start.line : null;
  };
  assert.equal(definitionLine('ref mocktype.mock_api'), 12);
  assert.equal(definitionLine('ref mocktype.${local.mock_target}'), null);
  const deferredUse = ws.references(commonUri)
    .find((ref) => ref.range.start.line === 20 && ref.range.start.character === 21);
  assert.equal(deferredUse.kind, 'error');
  const typed = commonText.replace('    size: 1\n    labels:', '    size: 1\n    ref mocktype.\n    labels:');
  await ws.sync(commonUri, common, typed);
  const offered = ws.completion(commonUri, positionAt(typed, '    ref mocktype.\n', '    ref mocktype.'.length))
    .map((item) => item.label);
  assert.ok(offered.includes('ref mocktype.mock_primary'), offered.join(', '));
  assert.ok(offered.includes('ref mocktype.mock_api'), offered.join(', '));
  assert.ok(offered.includes('ref mocktype.${env}_socket'), offered.join(', '));
  const deferredOffers = offered.filter((label) => label.includes('mock_target') || label.includes('mock_missing'));
  assert.deepEqual(deferredOffers, []);
});

test('completion at a key being typed offers the names a reference rule reads, '
  + 'written from the key\'s start', async () => {
  const typed = commonText.replace('  mock_unknown: 1\n', '  mock_unknown: 1\n  ref mocktype.mo\n');
  await ws.sync(commonUri, common, typed);
  const items = ws.completion(commonUri, positionAt(typed, '  ref mocktype.mo\n', '  ref mocktype.mo'.length));
  const primary = items.find((item) => item.label === 'ref mocktype.mock_primary');
  assert.deepEqual(primary.range.start, positionAt(typed, '  ref mocktype.mo\n', 2));
  const keyed = ws.completion(commonUri, positionAt(typed, '  mock_unknown: 1', '  mock_unknown: '.length))
    .filter((item) => item.label.startsWith('ref '));
  assert.deepEqual(keyed, []);
});

test('rename from a key reference renames the declaration and every reference, keys included', () => {
  const renamedAt = positionAt(commonText, 'ref mocktype.mock_primary:', 'ref mocktype.'.length);
  const answer = ws.rename(commonUri, renamedAt, 'mock_main');
  const edits = answer.edit.documentChanges[0].edits.map((edit) => [edit.range.start.line, edit.newText]);
  assert.deepEqual(edits.sort((left, right) => left[0] - right[0]), [
    [2, 'mock_main'],
    [4, 'mock_main'],
    [6, 'mock_main'],
    [22, 'mock_main'],
  ]);
});

test('a key reference is drawn as a reference: its literal, its scope and its name', () => {
  const keyTokens = ws.semanticTokens(commonUri)
    .filter((token) => token.line === 22)
    .map((token) => [token.character, token.length, token.type]);
  assert.deepEqual(keyTokens, [[2, 4, 'keyword'], [6, 8, 'type'], [14, 1, 'operator'], [15, 12, 'variable']]);
});

test('a deferred key\'s map reports no property, required or value problem, '
  + 'while a sibling\'s problem shows', async () => {
  await ws.whenValidated();
  const messages = ws.problems(commonUri)
    .map((problem) => [problem.range.start.line, problem.message]);
  assert.deepEqual(messages, [
    [15, '`size` must be `integer`'],
    [23, '`mock_unknown` is not defined in the schema'],
  ]);
});

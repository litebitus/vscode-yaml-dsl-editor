const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { scope, declaration, reference, placeholder, dslEntry, configText } = require('./config-builders');

const inPlaceholders = ['whole_placeholder', 'placeholder_in_text'];

const placeholderNamesEntry = dslEntry('placeholder-names', {
  file_includes: ['**/mock.yml'],
  placeholder: placeholder(),
  locals: { scope_name: 'local', path_separator: '.' },
  scopes: { GLOBAL: scope({ builtin_names: ['env'] }), local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
  declarations: [
    declaration('$.locals.*', 'local'),
    declaration('$.*.*', 'ENTRY', {
      skip_keys: ['locals'],
      key_token: 'last_word',
      name_spelling: 'dashes_as_underscores',
    }),
  ],
  references: [
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>(?:[a-z0-9_]|\\$\\{[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)*\\})+)', 'ENTRY', {
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

const root = '/repo/mock-stack';
const common = `${root}/mock.yml`;
const commonText = [
  'locals:',
  '  mock_id: mock',
  '  basenames:',
  '    api: ${local.mock_id}-api',
  '    looped: ${local.basenames.looped}',
  'mocktype:',
  '  name ${local.basenames.api}:',
  '    size: 1',
  '  name ${local.mock_id}-socket:',
  '    size: 1',
  '  user:',
  '    by_value: ref mocktype.mock_api',
  '    by_placeholder: ref mocktype.${local.mock_id}_api',
  '    by_placeholder_socket: ref mocktype.${local.mock_id}_socket',
  '    looped: ref mocktype.${local.basenames.looped}',
  '',
].join('\n');

function positionAt(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(needle);
  return {
    line: text.slice(0, index).split('\n').length - 1,
    character: index - text.lastIndexOf('\n', index - 1) - 1,
  };
}

let ws;

test.beforeEach(async () => {
  ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? commonText : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText(placeholderNamesEntry), dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, commonText);
});

test.afterEach(() => {
  ws.close(`file://${common}`);
  ws = null;
});

function definitionLine(needle) {
  const found = ws.definition(`file://${common}`, positionAt(commonText, needle));
  return found ? found.range.start.line : null;
}

test('a key holding a path into a local is known by the value at that path, spelled by its declaration rule', () => {
  assert.equal(definitionLine('ref mocktype.mock_api'), 6);
});

test('a ref whose name holds a local placeholder names the declaration known by the local\'s value', () => {
  assert.equal(definitionLine('ref mocktype.${local.mock_id}_api'), 6);
  assert.equal(definitionLine('ref mocktype.${local.mock_id}_socket'), 8);
  const hover = ws.hover(`file://${common}`, positionAt(commonText, 'ref mocktype.${local.mock_id}_api'));
  assert.doesNotMatch(hover ? hover.contents.value : '', /Invalid reference/);
});

test('a ref name holding a path to a local that reaches itself names nothing', () => {
  assert.equal(definitionLine('ref mocktype.${local.basenames.looped}'), null);
  const hover = ws.hover(`file://${common}`, positionAt(commonText, 'ref mocktype.${local.basenames.looped}'));
  assert.match(hover.contents.value, /^Invalid reference: mocktype/);
});

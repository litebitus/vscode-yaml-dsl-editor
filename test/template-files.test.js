const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { createVirtualWorkspace } = require('./virtual-document-schemas');
const { parseConfig, claimFile } = require('../lib/config');
const { languageOfDsl } = require('../lib/dsl-languages');
const { scope, declaration, reference, placeholder, dslEntry } = require('./config-builders');

const inPlaceholders = ['whole_placeholder', 'placeholder_in_text'];

const mockDsl = dslEntry('mock-dsl', {
  file_includes: ['**/mock.yml'],
  layers: {
    overlay_folders: ['dev'],
    common_layer_discovery: 'ancestor',
    duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
  },
  placeholder: placeholder(),
  locals: { scope_name: 'local' },
  scopes: { local: scope(), ENTRY: scope({ named_by_parent_key: true }) },
  declarations: [
    declaration('$.locals.*', 'local'),
    declaration('$.*.*', 'ENTRY', { skip_keys: ['locals'], key_token: 'last_word', name_spelling: 'dashes_as_underscores' }),
  ],
  references: [
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', 'ENTRY', { text_after_name_allowed: true, scope_group: 'type' }),
    reference('^local\\.(?<name>[a-z0-9_]+)', 'local', {
      positions: ['whole_scalar', ...inPlaceholders],
      text_after_name_allowed: true,
    }),
  ],
});

const mockTemplates = {
  id: 'mock-dsl-templates',
  dsl: 'mock-dsl',
  file_includes: ['{config_root}/templates/**'],
  file_excludes: [],
  delimiters: { left: '[[', right: ']]' },
  conditional: { if: 'if', else_if: 'else if', else: 'else', end: 'end' },
  loop: { start: '^range (?<variables>\\$[a-z_]+) := ', end: 'end', variable: '\\$[a-z_]+' },
  variable: '\\.[a-z_][a-z0-9_.]*',
  schema_search_paths: ['{config_root}/mock.schema.json'],
};

const configText = YAML.stringify({ version: '1', dsls: [mockDsl], templates: [mockTemplates] });

const schema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    locals: { type: 'object' },
    mocktype: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          size: { type: 'integer' },
          source: { type: 'string' },
          label: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
});

const common = '/repo/templates/mock.yml';
const overlay = '/repo/templates/dev/mock.yml';
const document = '/repo/stacks/mock.yml';
const commonText = [
  'locals:',
  '  team: [[ .team ]]',
  'mocktype:',
  '  shared:',
  '    size: 1',
  '',
].join('\n');
const overlayText = [
  'mocktype:',
  '  user:',
  '    size: [[ .size ]]',
  '    source: ref mocktype.shared',
  '    label: local.team',
  '    tags:',
  '[[ range $item := .items ]]',
  '      - "[[ $item ]]"',
  '[[ end ]]',
  '[[ if .flagged ]]',
  '  extra: {}',
  '[[ else ]]',
  '  extra: {}',
  '[[ end ]]',
  '[[ end ]]',
  '',
].join('\n');

function positionAt(text, needle, shift = 0) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(needle);
  const at = index + shift;
  return { line: text.slice(0, at).split('\n').length - 1, character: at - text.lastIndexOf('\n', at - 1) - 1 };
}

let ws;

test.beforeEach(async () => {
  const files = { '/repo/mock.schema.json': schema, [common]: commonText, [overlay]: overlayText };
  ws = createVirtualWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: configText, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, commonText);
  await ws.sync(`file://${overlay}`, overlay, overlayText);
});

test.afterEach(() => {
  ws.close(`file://${common}`);
  ws.close(`file://${overlay}`);
  ws = null;
});

test('a file both the DSL and the template language claim opens as a template, and a document stays the DSL\'s', () => {
  const dsls = parseConfig(configText).dsls.map((dsl) => ({ ...dsl, dir: '/repo' }));
  const claimed = claimFile(overlay, dsls);
  assert.equal(claimed.status, 'one');
  assert.equal(languageOfDsl(claimed.dsl), 'yaml-dsl-template');
  assert.equal(languageOfDsl(claimFile(document, dsls).dsl), 'yaml-dsl');
});

test('an overlay template reads its common layer template, and its values known only when rendered raise nothing', () => {
  const definition = ws.definition(`file://${overlay}`, positionAt(overlayText, 'ref mocktype.shared', 4));
  assert.equal(definition.path, common);
  assert.equal(ws.definition(`file://${overlay}`, positionAt(overlayText, 'local.team', 1)).path, common);
  const messages = ws.problems(`file://${overlay}`).map((problem) => problem.message);
  assert.deepEqual(messages, ['`[[ end ]]` closes no conditional or loop']);
});

test('a loop variable leads to its loop, and a template variable hovers as a value the template is rendered with', () => {
  const loopVariable = positionAt(overlayText, '[[ $item ]]', 4);
  const loopDefinition = ws.definition(`file://${overlay}`, loopVariable);
  assert.equal(loopDefinition.range.start.line, 6);
  assert.match(ws.hover(`file://${overlay}`, loopVariable).contents.value, /a loop variable of/);
  const templateVariable = positionAt(overlayText, '.size', 1);
  assert.equal(ws.hover(`file://${overlay}`, templateVariable).contents.value,
    'template variable `.size`, a value the template is rendered with');
});

test('a template draws its delimiters, directive words, loop variables and template variables', () => {
  const tokens = ws.semanticTokens(`file://${overlay}`).map((token) => [token.line, token.character, token.length, token.type]);
  assert.ok(tokens.some(([line, character, length, type]) => line === 6 && character === 3 && length === 5 && type === 'keyword'));
  assert.ok(tokens.some(([line, , length, type]) => line === 7 && length === 5 && type === 'variable'));
  assert.ok(tokens.some(([line, , length, type]) => line === 2 && length === 5 && type === 'parameter'));
});

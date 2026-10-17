const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace, SCHEMA_UNAVAILABLE } = require('../lib/workspace');
const {
  scope,
  declaration,
  reference,
  placeholder,
  markerFunction,
  dslEntry,
  configText,
} = require('./config-builders');

const schema = JSON.stringify({
  description: 'root',
  properties: {
    mocktype: { $ref: '#/definitions/mocktype_map', description: '[optional] Mock things.' },
  },
  definitions: {
    string_or_ref: { description: 'a literal string, a ref, or a bare local' },
    mocktype_map: { patternProperties: { '^(?!defaults$).+$': { $ref: '#/definitions/mocktype' } } },
    mocktype: { properties: { label: { $ref: '#/definitions/string_or_ref', description: '[optional] Mock label.' }, source: { description: 'source' } } },
  },
});

const inPlaceholders = ['whole_placeholder', 'placeholder_in_text'];

async function visitStack(ws, filePath) {
  await ws.setActive(filePath);
  await ws.setActive(null);
}

function entryReferences(refNamePattern = '[a-z0-9_]+') {
  return [
    reference(`^ref (?<type>[a-z0-9_]+)\\.(?<name>${refNamePattern})`, 'ENTRY', {
      text_after_name_allowed: true,
      scope_group: 'type',
    }),
    reference('^local\\.(?<name>[a-z0-9_]+)$', 'local', { positions: ['whole_scalar', ...inPlaceholders] }),
    reference('^(?<name>[a-z_]+)$', 'GLOBAL', { positions: inPlaceholders }),
  ];
}

function sampleEntry(fields = {}, localKeyToken = 'all_words') {
  return dslEntry('sample', {
    schema_search_paths: ['https://example.test/fallback.json'],
    layers: {
      overlay_folders: ['one', 'two', 'three', 'four'],
      common_layer_discovery: 'ancestor',
      duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
    },
    placeholder: placeholder(),
    locals: { scope_name: 'local' },
    scopes: {
      GLOBAL: scope({ builtin_names: ['env'] }),
      ENTRY: scope({ named_by_parent_key: true }),
      local: scope(),
    },
    declarations: [
      declaration('$.locals.*', 'local', { key_token: localKeyToken }),
      declaration('$.*.*', 'ENTRY', {
        skip_keys: ['schema_version', 'cloud', 'env', 'locals', 'outputs', 'sync'],
        exclude_candidates: ['defaults'],
        key_token: 'last_word',
        name_spelling: 'dashes_as_underscores',
      }),
    ],
    references: entryReferences(),
    ...fields,
  });
}

const config = configText(sampleEntry());

const root = '/repo/mock-stack';
const common = `${root}/mock.yml`;
const one = `${root}/one/mock.yml`;
const two = `${root}/two/mock.yml`;
const three = `${root}/three/mock.yml`;
const four = `${root}/four/mock.yml`;

function at(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(needle);
  const line = text.slice(0, index).split('\n').length - 1;
  return { line, character: index - text.lastIndexOf('\n', index - 1) - 1 };
}

function workspace(files, fetchText, readFile) {
  const reads = [];
  const ws = createWorkspace({
    readFile: readFile || (async (filePath) => {
      reads.push(filePath);
      if (Object.prototype.hasOwnProperty.call(files, filePath)) return files[filePath];
      return null;
    }),
    fetchText: fetchText || (async () => { throw new Error('unused'); }),
  });
  ws.reads = reads;
  return ws;
}

test('hover, definition, and folds see the file\'s own layer and the common layer, never another overlay', async () => {
  const files = {
    [`${root}/schema.json`]: schema,
    [common]: '# yaml-language-server: $schema=schema.json\nlocals:\n  db: mock-value\nmocktype:\n  primary:\n    label: local.db\n',
    [one]: '# yaml-language-server: $schema=../schema.json\nmocktype:\n  replica:\n    source: ref mocktype.primary.tail\n    label: "pre ${local.db}"\n',
    [two]: '# yaml-language-server: $schema=../schema.json\nmocktype:\n  replica:\n    source: ref mocktype.primary\n    source2: ref mocktype.shared\n    gone: ref mocktype.nope\n',
    [three]: '# yaml-language-server: $schema=../schema.json\nmocktype:\n  shared: {}\n',
    [four]: '# yaml-language-server: $schema=../schema.json\nmocktype:\n  shared: {}\n',
  };
  const fetched = [];
  const ws = workspace(files, async (url) => {
    fetched.push(url);
    return null;
  });
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync('file://' + one, one, files[one]);
  const before = ws.reads.length;
  await ws.setActive(common);
  assert.equal(ws.reads.length, before);
  assert.equal(fetched.length, 0);

  const oneUri = 'file://' + one;
  const sourceHover = ws.hover(oneUri, at(files[one], 'ref mocktype.primary'));
  assert.match(sourceHover.contents.value, /\[mock-stack\/mock\.yml:\d+\]\(file:\/\/.*#L\d+\)/);
  assert.doesNotMatch(sourceHover.contents.value, /mocktype\.primary —/);
  const sourceDef = ws.definition(oneUri, at(files[one], 'ref mocktype.primary'));
  assert.equal(sourceDef.path, common);

  await ws.sync('file://' + common, common, files[common]);
  const localHover = ws.hover('file://' + common, at(files[common], 'local.db'));
  assert.match(localHover.contents.value, /```yaml-dsl/);
  assert.match(localHover.contents.value, /db:/);
  assert.equal(ws.definition('file://' + common, at(files[common], 'local.db')).path, common);
  const field = ws.hover('file://' + common, at(files[common], 'label'));
  const labelDocumentation = '```\nlabel: string_or_ref    [optional]\n```\n\nMock label.';
  assert.deepEqual(field.contents, { kind: 'markdown', value: labelDocumentation });

  const within = ws.hover(oneUri, at(files[one], 'local.db'));
  assert.match(within.contents.value, /mock-stack\/mock\.yml:\d+/);
  assert.match(within.contents.value, /db:/);

  assert.deepEqual(ws.foldsFor(one), { stackId: common, overlayNames: ['one'], overlayLabels: ['one'] });
  assert.deepEqual(ws.foldsFor(common).overlayNames, ['one', 'two', 'three', 'four']);
  const folded = ws.foldText(common, 'one');
  assert.match(folded, /the one overlay/);
  assert.match(folded, /mock-value/);
  assert.match(ws.foldText(common, 'two'), /the two overlay/);
  const twoFold = ws.foldText(common, 'two');
  assert.match(twoFold, /the two overlay/);

  const foldUri = `yaml-dsl-fold:${encodeURIComponent(common)}/one`;
  assert.deepEqual(ws.links(foldUri), []);
  assert.deepEqual(ws.links('file://missing'), []);
  const foldHover = ws.hover(foldUri, at(folded, 'label'));
  assert.equal(foldHover.contents.value, labelDocumentation);
  const foldDef = ws.definition(foldUri, at(folded, 'ref mocktype.primary'));
  assert.equal(foldDef.path, common);

  await ws.sync('file://' + two, two, files[two]);
  assert.equal(ws.definition('file://' + two, at(files[two], 'ref mocktype.shared')), null);
  const twoKinds = ws.references('file://' + two).map((reference) => reference.kind);
  assert.deepEqual(twoKinds, ['external', 'error', 'error']);
  const unresolved = ws.hover('file://' + two, at(files[two], 'ref mocktype.primary'));
  assert.match(unresolved.contents.value, /mock-stack\/mock\.yml:\d+/);
  assert.doesNotMatch(unresolved.contents.value, /mocktype\.primary —/);
  assert.equal(ws.definition('file://' + two, at(files[two], 'ref mocktype.nope')), null);
  await ws.sync(foldUri, foldUri, 'name: overwritten\n');
  assert.match(ws.hover('file://' + common, at(files[common], 'local.db')).contents.value, /```yaml-dsl/);

  assert.equal(ws.hover('file://missing', { line: 0, character: 0 }), null);
  assert.equal(ws.definition('yaml-dsl-fold:nope', { line: 0, character: 0 }), null);
  assert.equal(ws.foldText('/missing', 'one'), '');
  assert.deepEqual(ws.foldsFor('/missing'), { stackId: null, overlayNames: [], overlayLabels: [] });
  assert.equal(SCHEMA_UNAVAILABLE, 'schema is unavailable');
});

test('a schema search path starting with {config_root} is read from the config folder for a file at any depth', async () => {
  const text = 'name: plain\n';
  const files = {
    '/repo/examples/schemas/mock.schema.json': JSON.stringify({ properties: { name: { description: 'the name' } } }),
    '/repo/examples/mock-dsl/deep/nested/mock.yml': text,
  };
  const ws = workspace(files, async () => null);
  const rooted = dslEntry('sample', { schema_search_paths: ['{config_root}/../schemas/mock.schema.json'] });
  await ws.setConfigs([{ text: configText(rooted), dir: '/repo/examples/mock-dsl' }]);
  const uri = 'file:///repo/examples/mock-dsl/deep/nested/mock.yml';
  await ws.sync(uri, '/repo/examples/mock-dsl/deep/nested/mock.yml', text);
  assert.equal(ws.problems(uri).some((item) => item.message === SCHEMA_UNAVAILABLE), false);
  assert.equal(ws.hover(uri, at(text, 'name')).contents.value, '```\nname    [optional]\n```\n\nthe name');
});

test('a modeline that fails falls through to the published schema', async () => {
  const files = {
    '/repo/only/mock.yml': '# yaml-language-server: $schema=https://example.test/missing.json\nname: plain\n',
    '/repo/bad.json': '[',
    '/repo/good/mock.yml': '# yaml-language-server: $schema=../bad.json\nname: plain\n',
    '/repo/disk/mock.yml': 'name: from-disk\n',
  };
  const ws = workspace(files, async (url) => (url.endsWith('fallback.json') ? schema : null));
  const relative = configText(dslEntry('sample', { schema_search_paths: ['schema.json'] }));
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync('file:///repo/only/mock.yml', '/repo/only/mock.yml', files['/repo/only/mock.yml']);
  const diags = ws.problems('file:///repo/only/mock.yml');
  assert.equal(diags.some((item) => item.message === 'schema is unavailable'), false);
  await ws.sync('file:///repo/good/mock.yml', '/repo/good/mock.yml', files['/repo/good/mock.yml']);
  assert.equal(ws.problems('file:///repo/good/mock.yml').some((item) => item.message === 'schema is unavailable'), false);

  await ws.setConfigs([{ text: 'dsls: [', dir: '/repo' }]);
  await ws.sync('file:///repo/yaml-dsl.yml', '/repo/yaml-dsl.yml', 'dsls: [');
  assert.ok(ws.problems('file:///repo/yaml-dsl.yml')[0].message.length > 0);
  assert.deepEqual(ws.problems('file:///elsewhere/yaml-dsl.yml'), []);

  const open = 'name: from-editor\n';
  await ws.setConfigs([{ text: relative, dir: '/repo/disk' }]);
  await ws.sync('file:///repo/disk/mock.yml', '/repo/disk/mock.yml', open);
  files['/repo/disk/schema.json'] = JSON.stringify({ properties: { name: { description: 'the name' } } });
  const edited = '# yaml-language-server: $schema=schema.json\nname: edited\n';
  await ws.sync('file:///repo/disk/mock.yml', '/repo/disk/mock.yml', edited);
  const field = ws.hover('file:///repo/disk/mock.yml', at(edited, 'name'));
  assert.equal(field.contents.value, '```\nname    [optional]\n```\n\nthe name');
  const boom = workspace({}, async () => schema, async () => { throw new Error('boom'); });
  await boom.setConfigs([{ text: config, dir: '/repo' }]);
  await boom.sync('file:///repo/boom/mock.yml', '/repo/boom/mock.yml', '# yaml-language-server: $schema=missing.json\nname: plain\n');
  assert.equal(boom.problems('file:///repo/boom/mock.yml').some((item) => item.message === 'schema is unavailable'), false);
});

test('two DSLs, a parse error, and a DSL without layers', async () => {
  const both = configText(dslEntry('a'), dslEntry('b'), dslEntry('note', {
    file_includes: ['**/note.yml'],
    scopes: { local: scope() },
    declarations: [declaration('$.locals.*', 'local')],
    references: [reference('^local\\.(?<name>[a-z0-9_]+)$', 'local')],
  }));
  const ws = workspace({}, async () => null);
  await ws.setConfigs([{ text: both, dir: '/repo' }]);
  await ws.sync('file:///repo/mock.yml', '/repo/mock.yml', 'name: a\n');
  assert.match(ws.problems('file:///repo/mock.yml')[0].message, /claimed by a and b/);
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals:\n  db: mock-value\nuse: local.db\n');
  const hover = ws.hover('file:///repo/note.yml', at('locals:\n  db: mock-value\nuse: local.db\n', 'local.db'));
  assert.match(hover.contents.value, /```yaml-dsl/);
  assert.match(hover.contents.value, /mock-value/);
  assert.deepEqual(ws.foldsFor('/repo/note.yml'), { stackId: null, overlayNames: [], overlayLabels: [] });
  assert.equal(ws.foldText('/repo/note.yml', 'one'), '');
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals:\n  db: 1\n  sc\n  db: 2\n  db: 3\n');
  const keyProblems = ws.problems('file:///repo/note.yml').filter((problem) => problem.kind);
  assert.deepEqual(keyProblems.map(({ message, severity, kind }) => [message, severity, kind]), [
    ['`sc` needs a `:`', 'error', 'unfinishedKey'],
    ['`db` is also at lines 4, 5', 'warning', 'duplicateKey'],
    ['`db` is also at lines 2, 5', 'warning', 'duplicateKey'],
    ['`db` is also at lines 2, 4', 'warning', 'duplicateKey'],
  ]);
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals:\n  db: 1\n  db: 2\n');
  assert.equal(ws.problems('file:///repo/note.yml')[0].message, '`db` is also at line 3');
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals: [\n');
  assert.ok(ws.problems('file:///repo/note.yml').length > 0);
  await ws.setActive(null);
  await ws.setActive('/repo/missing.yml');
  ws.setVisibleFolds(['/repo/note.yml']);
  assert.equal(ws.hover('yaml-dsl-fold:%2Frepo%2Fmissing/one', { line: 0, character: 0 }), null);
  ws.close('file:///repo/note.yml');
  assert.deepEqual(ws.problems('file:///repo/note.yml'), []);
});

test('loading past the pin capacity evicts the oldest unpinned stack', async () => {
  const plain = configText(dslEntry('sample', {
    layers: {
      overlay_folders: ['one'],
      common_layer_discovery: 'parent',
      duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
    },
  }));
  const ws = workspace({}, async () => null);
  await ws.setConfigs([{ text: plain, dir: '/repo' }]);
  ws.setCacheCapacities({ stackCapacity: 7, schemaCapacity: 32 });
  for (let i = 0; i < 10; i += 1) {
    const file = `/repo/s${i}/mock.yml`;
    await ws.setActive(file);
    await ws.sync('file://' + file, file, 'name: a\n');
    if (i !== 2) ws.close('file://' + file);
  }
  ws.setVisibleFolds(['/repo/s1/mock.yml']);
  assert.equal(ws.cache.get('/repo/s0/mock.yml'), null);
  assert.ok(ws.cache.get('/repo/s1/mock.yml'));
  assert.ok(ws.cache.get('/repo/s2/mock.yml'));
  assert.ok(ws.takeEvicted().includes('/repo/s0/mock.yml'));
});

test('a missing modeline walks the schema search path from the file', async () => {
  const found = '/repo/mock-app/one/.schema/sample.schema.json';
  const files = {
    [found]: JSON.stringify({ properties: { name: { description: 'from the side stack' } } }),
  };
  const ws = workspace(files, async () => null);
  await ws.setConfigs([{
    text: configText(dslEntry('sample', {
      schema_search_paths: ['.schema/sample.schema.json', 'one/.schema/sample.schema.json', 1],
    })),
    dir: '/repo',
  }]);
  const common = '/repo/mock-app/mock.yml';
  const text = 'name: plain\n';
  await ws.sync('file://' + common, common, text);
  assert.ok(ws.reads.includes('/repo/mock-app/.schema/sample.schema.json'));
  assert.ok(ws.reads.includes(found));
  const fromSideStack = '```\nname    [optional]\n```\n\nfrom the side stack';
  assert.equal(ws.hover('file://' + common, at(text, 'name')).contents.value, fromSideStack);
  const overlayPath = '/repo/mock-app/one/mock.yml';
  await ws.sync('file://' + overlayPath, overlayPath, text);
  assert.equal(ws.hover('file://' + overlayPath, at(text, 'name')).contents.value, fromSideStack);
  const named = '# yaml-language-server: $schema=missing.json\n' + text;
  await ws.sync('file://' + common, common, named);
  assert.equal(ws.hover('file://' + common, at(named, 'name')).contents.value, fromSideStack);
  const bare = '/repo/bare/mock.yml';
  const bareText = 'name: plain\n';
  await ws.setConfigs([{ text: configText(dslEntry('sample')), dir: '/repo' }]);
  await ws.sync('file://' + bare, bare, bareText);
  assert.ok(ws.problems('file://' + bare).some((item) => item.message === 'schema is unavailable'));
  assert.equal(ws.hover('file://' + bare, at(bareText, 'name')), null);
});

test('a line edit re-parses that file and leaves the rest of the stack', async () => {
  const common = '/repo/mock.yml';
  const overlay = '/repo/one/mock.yml';
  const schema = '/repo/schema.json';
  const files = {
    [schema]: JSON.stringify({ properties: { name: { description: 'the name' } } }),
    [common]: 'locals:\n  db: common\n',
    [overlay]: 'locals:\n  db: overlay\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{
    text: configText(dslEntry('sample', {
      schema_search_paths: ['schema.json'],
      layers: {
        overlay_folders: ['one'],
        common_layer_discovery: 'parent',
        duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
      },
      scopes: { local: scope() },
      declarations: [declaration('$.locals.*', 'local')],
    })),
    dir: '/repo',
  }]);
  await visitStack(ws, overlay);
  await visitStack(ws, '/other/mock.yml');
  assert.ok(ws.reads.includes(common));
  assert.ok(ws.reads.includes(overlay));
  assert.ok(ws.reads.includes(schema));
  const marked = ws.reads.length;
  await visitStack(ws, common);
  const edited = 'locals:\n  kept: overlay\n';
  await ws.sync('file://' + overlay, overlay, edited);
  assert.equal(ws.reads.length, marked);
  const entry = ws.cache.get(common);
  assert.equal(entry.data.files.get(overlay).text, edited);
  assert.equal(entry.data.files.get(common).text, files[common]);
  assert.ok(entry.data.symbols.some((symbol) => symbol.file === overlay && symbol.name === 'kept'));
  assert.ok(entry.data.symbols.some((symbol) => symbol.file === common && symbol.name === 'db'));
  await ws.sync('file://' + overlay, overlay, '# yaml-language-server: $schema=schema.json\n' + edited);
  assert.ok(ws.reads.length > marked);
  const raced = ws.sync('file://' + overlay, overlay, 'locals:\n  later: 1\n');
  ws.close('file://' + overlay);
  await raced;
});

const validatedStackSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mocktype: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '[required] Mock name.' },
          size: { type: 'integer', description: '[required] Mock size.' },
          mode: { enum: ['fast', 'slow'], description: '[optional] Mock mode.' },
        },
      },
    },
  },
});

const validatorRules = {
  merge_base_keys: ['defaults'],
  child_values_from_parent_key: [{ pattern: '^(?<field>[a-z]+) (?<value>[a-z0-9-]+)$' }],
};

function validationMessages(ws, filePath) {
  return ws.problems(`file://${filePath}`)
    .filter((problem) => problem.kind === 'validationError')
    .map((problem) => [problem.range.start.line, problem.message]);
}

test('each overlay\'s fold is validated, each error placed in the file that wrote the value', async () => {
  const modeline = (schemaPath) => `# yaml-language-server: $schema=${schemaPath}\n`;
  const files = {
    [`${root}/schema.json`]: validatedStackSchema,
    [common]: `${modeline('schema.json')}mocktype:\n  defaults:\n    size: 1\n  name mock-shared:\n    mode: medium\n  name mock-opted:\n    size: 2\n`,
    [one]: `${modeline('../schema.json')}mocktype:\n  name mock-one:\n    size: large\n  extra: {}\n  name mock-opted: {}\n`,
    [two]: `${modeline('../schema.json')}mocktype:\n  name mock-shared:\n    size: 2\n`,
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(sampleEntry({ validator: validatorRules })), dir: '/repo' }]);
  for (const filePath of [common, one, two]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  await visitStack(ws, one);
  assert.deepEqual(validationMessages(ws, one), [
    [3, '`size` must be integer'],
    [4, '`name` is required'],
  ]);
  assert.deepEqual(validationMessages(ws, two), []);
  assert.deepEqual(validationMessages(ws, common), [[5, '`mode` must be one of `"fast"`, `"slow"` (one, two)']]);
  await ws.sync(`file://${one}`, one, `${files[one]}  broken: [\n`);
  assert.deepEqual(validationMessages(ws, one), []);
  const unruled = workspace(files);
  await unruled.setConfigs([{ text: configText(sampleEntry()), dir: '/repo' }]);
  for (const filePath of [common, one, two]) await unruled.sync(`file://${filePath}`, filePath, files[filePath]);
  await visitStack(unruled, two);
  assert.deepEqual(validationMessages(unruled, two), [[2, '`name` is required']]);
});

test('hover on a key that sets a field of its entry documents the entry, then the field it sets', async () => {
  const modeline = '# yaml-language-server: $schema=../schema.json\n';
  const identifiedSchema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      mocktype: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          description: '[optional] A mock entry.',
          properties: {
            id: { type: 'string', pattern: '^[a-z-]+$', description: '[required] Mock identity.' },
            size: { type: 'integer', description: '[optional] Mock size.' },
          },
        },
      },
    },
  });
  const files = {
    [`${root}/schema.json`]: identifiedSchema,
    [common]: 'mocktype: {}\n',
    [one]: `${modeline}mocktype:\n  id mock-one:\n    size: 1\n  id mock-two:\n    id: mock-own\n  extra:\n    size: 2\n`,
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(sampleEntry({ validator: validatorRules })), dir: '/repo' }]);
  for (const filePath of [common, one]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  const hoverOf = (needle) => ws.hover(`file://${one}`, at(files[one], needle)).contents.value;
  const entryOf = (key) => `\`\`\`\n${key}: object    [optional]\n\`\`\`\n\nA mock entry.`;
  const idDocumentation = '```\nid: string    [required]\n```\n\nMock identity.\n\n*Pattern:* `^[a-z-]+$`';
  assert.equal(
    hoverOf('id mock-one'),
    `${entryOf('id mock-one')}\n\n*Sets* \`id\` *to* \`mock-one\`:\n\n${idDocumentation}`,
  );
  assert.equal(hoverOf('id mock-two'), entryOf('id mock-two'));
  assert.equal(hoverOf('extra'), entryOf('extra'));
});

test('a schema that changes on disk revalidates every file reading it, the common layer included', async () => {
  const modeline = (schemaPath) => `# yaml-language-server: $schema=${schemaPath}\n`;
  const schemaPath = `${root}/schema.json`;
  const files = {
    [schemaPath]: validatedStackSchema,
    [common]: `${modeline('schema.json')}mocktype:\n  shared:\n    mode: medium\n`,
    [one]: `${modeline('../schema.json')}mocktype:\n  shared:\n    name: mock\n    size: 1\n`,
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(sampleEntry({ validator: validatorRules })), dir: '/repo' }]);
  for (const filePath of [common, one]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  await visitStack(ws, one);
  assert.deepEqual(validationMessages(ws, common), [[3, '`mode` must be one of `"fast"`, `"slow"` (one)']]);
  const widened = JSON.parse(validatedStackSchema);
  widened.properties.mocktype.additionalProperties.properties.mode.enum.push('medium');
  widened.properties.mocktype.additionalProperties.properties.size.type = 'string';
  files[schemaPath] = JSON.stringify(widened);
  await ws.schemasChanged([schemaPath]);
  await visitStack(ws, one);
  assert.deepEqual(validationMessages(ws, common), []);
  assert.deepEqual(validationMessages(ws, one), [[4, '`size` must be string']]);
});

test('an overlay schema that changes drops that overlay from the common layer\'s error, the other overlay\'s schema kept', async () => {
  const modeline = '# yaml-language-server: $schema=.schema/sample.schema.json\n';
  const oneSchemaPath = `${root}/one/.schema/sample.schema.json`;
  const twoSchemaPath = `${root}/two/.schema/sample.schema.json`;
  const files = {
    [oneSchemaPath]: validatedStackSchema,
    [twoSchemaPath]: validatedStackSchema,
    [common]: 'mocktype:\n  name mock-shared:\n    size: 1\n',
    [one]: `${modeline}mocktype:\n  name mock-own:\n    size: 2\n    mode: fast\n`,
    [two]: `${modeline}mocktype:\n  name mock-own:\n    size: 2\n    mode: fast\n`,
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(sampleEntry({ validator: validatorRules })), dir: '/repo' }]);
  for (const filePath of [common, one, two]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  await visitStack(ws, common);
  assert.deepEqual(validationMessages(ws, common), []);
  const modeRequired = JSON.parse(validatedStackSchema);
  modeRequired.properties.mocktype.additionalProperties.properties.mode.description = '[required] Mock mode.';
  files[oneSchemaPath] = JSON.stringify(modeRequired);
  files[twoSchemaPath] = JSON.stringify(modeRequired);
  await ws.schemasChanged([oneSchemaPath, twoSchemaPath]);
  await visitStack(ws, common);
  assert.deepEqual(validationMessages(ws, common), [[1, '`mode` is required (one, two)']]);
  files[twoSchemaPath] = validatedStackSchema;
  await ws.schemasChanged([twoSchemaPath]);
  await visitStack(ws, common);
  assert.deepEqual(validationMessages(ws, common), [[1, '`mode` is required (one)']]);
});

test('a common layer field hover shows each overlay schema\'s documentation, the overlays that agree sharing one section', async () => {
  const modeline = '# yaml-language-server: $schema=.schema/sample.schema.json\n';
  const schemaWith = (sizeDescription) => JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { mocktype: { additionalProperties: { properties: { size: { type: 'integer', description: sizeDescription } } } } },
  });
  const files = {
    [`${root}/one/.schema/sample.schema.json`]: schemaWith('[optional] Mock size.'),
    [`${root}/two/.schema/sample.schema.json`]: schemaWith('[required] Mock size, now required.'),
    [`${root}/three/.schema/sample.schema.json`]: schemaWith('[optional] Mock size.'),
    [common]: 'mocktype:\n  shared:\n    size: 1\n',
    [one]: `${modeline}mocktype: {}\n`,
    [two]: `${modeline}mocktype: {}\n`,
    [three]: `${modeline}mocktype: {}\n`,
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  for (const filePath of [common, one, two, three]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  assert.equal(ws.hover(`file://${common}`, at(files[common], 'size')).contents.value, [
    `${overlayHeadingOf('one, three')}\n\n\`\`\`\nsize: integer    [optional]\n\`\`\`\n\nMock size.`,
    `${overlayHeadingOf('two')}\n\n\`\`\`\nsize: integer    [required]\n\`\`\`\n\nMock size, now required.`,
  ].join('\n\n'));
  assert.equal(ws.hover(`file://${one}`, at(files[one], 'mocktype')).contents.value, '```\nmocktype    [optional]\n```');
  const twoSchemaPath = `${root}/two/.schema/sample.schema.json`;
  files[twoSchemaPath] = schemaWith('[optional] Mock size.');
  await ws.schemasChanged([twoSchemaPath]);
  assert.equal(
    ws.hover(`file://${common}`, at(files[common], 'size')).contents.value,
    '```\nsize: integer    [optional]\n```\n\nMock size.',
  );
});

test('a common layer field hover names the overlays whose schema has no such field, and drops them once it does', async () => {
  const modeline = '# yaml-language-server: $schema=.schema/sample.schema.json\n';
  const schemaWith = (properties) => JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { mocktype: { additionalProperties: { properties, additionalProperties: false } } },
  });
  const sized = schemaWith({ size: { type: 'integer', description: '[optional] Mock size.' } });
  const twoSchemaPath = `${root}/two/.schema/sample.schema.json`;
  const files = {
    [`${root}/one/.schema/sample.schema.json`]: sized,
    [twoSchemaPath]: schemaWith({}),
    [`${root}/three/.schema/sample.schema.json`]: schemaWith({}),
    [common]: 'mocktype:\n  shared:\n    size: 1\n',
    [one]: `${modeline}mocktype: {}\n`,
    [two]: `${modeline}mocktype: {}\n`,
    [three]: `${modeline}mocktype: {}\n`,
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  for (const filePath of [common, one, two, three]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  assert.equal(ws.hover(`file://${common}`, at(files[common], 'size')).contents.value, [
    `${overlayHeadingOf('one')}\n\n\`\`\`\nsize: integer    [optional]\n\`\`\`\n\nMock size.`,
    `${overlayHeadingOf('two, three')}\n\nnot a field`,
  ].join('\n\n'));
  files[twoSchemaPath] = sized;
  await ws.schemasChanged([twoSchemaPath]);
  assert.equal(ws.hover(`file://${common}`, at(files[common], 'size')).contents.value, [
    `${overlayHeadingOf('one, two')}\n\n\`\`\`\nsize: integer    [optional]\n\`\`\`\n\nMock size.`,
    `${overlayHeadingOf('three')}\n\nnot a field`,
  ].join('\n\n'));
  ws.setTheme('light');
  assert.equal(ws.hover(`file://${common}`, at(files[common], 'size')).contents.value, [
    `${overlayHeadingOf('one, two', 'light')}\n\n\`\`\`\nsize: integer    [optional]\n\`\`\`\n\nMock size.`,
    `${overlayHeadingOf('three', 'light')}\n\nnot a field`,
  ].join('\n\n'));
});

function overlayHeadingOf(labels, theme = 'dark') {
  return `<span style="color:var(--vscode-yamlDslEditor-${theme}-overlayHeadingForeground);"><strong>${labels}</strong></span>`;
}

test('the modeline\'s schema path links to the schema it names, a path from the file\'s folder or a URL as written', async () => {
  const urlModeline = '# yaml-language-server: $schema=https://example.test/mock.schema.json\n';
  const files = {
    [`${root}/schema.json`]: validatedStackSchema,
    [common]: 'mocktype: {}\n',
    [one]: '# yaml-language-server: $schema=../schema.json\nmocktype: {}\n',
    [two]: `${urlModeline}mocktype: {}\n`,
  };
  const ws = workspace(files, async () => validatedStackSchema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  for (const filePath of [common, one, two]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  const schemaLinkOf = (filePath) => ws.links(`file://${filePath}`).find((link) => link.target);
  const linked = schemaLinkOf(one);
  assert.deepEqual([linked.target, linked.range], [
    `file://${root}/schema.json`,
    { start: { line: 0, character: 32 }, end: { line: 0, character: 46 } },
  ]);
  assert.equal(schemaLinkOf(two).target, 'https://example.test/mock.schema.json');
  assert.equal(schemaLinkOf(common), undefined);
});

test('a schema written after the file opened replaces the missing one, and a new version replaces it again', async () => {
  const layered = configText(dslEntry('sample', {
    schema_search_paths: ['.schema/mock.schema.json', 'one/.schema/mock.schema.json'],
    layers: {
      overlay_folders: ['one', 'two'],
      common_layer_discovery: 'parent',
      duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
    },
  }));
  const commonPath = '/repo/mock-app/mock.yml';
  const onePath = '/repo/mock-app/one/mock.yml';
  const schemaPath = '/repo/mock-app/one/.schema/mock.schema.json';
  const files = {
    [commonPath]: 'name: plain\n',
    [onePath]: '# yaml-language-server: $schema=.schema/mock.schema.json\nname: plain\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: layered, dir: '/repo' }]);
  await ws.sync(`file://${onePath}`, onePath, files[onePath]);
  await ws.sync(`file://${commonPath}`, commonPath, files[commonPath]);
  const unavailable = (filePath) => ws.problems(`file://${filePath}`).some((item) => item.message === SCHEMA_UNAVAILABLE);
  assert.equal(unavailable(onePath), true);
  assert.equal(unavailable(commonPath), true);
  assert.equal(ws.problems(`file://${onePath}`)[0].range.start.line, 0);
  const named = `name: plain\n# yaml-language-server: $schema=.schema/mock.schema.json\n`;
  await ws.sync(`file://${onePath}`, onePath, named);
  assert.equal(ws.problems(`file://${onePath}`).find((item) => item.message === SCHEMA_UNAVAILABLE).range.start.line, 1);
  await ws.sync(`file://${onePath}`, onePath, files[onePath]);

  assert.deepEqual(ws.schemaWatchTargets().map((target) => [target.base, target.pattern]).sort(), [
    ['/repo/mock-app', '.schema'],
    ['/repo/mock-app', '.schema/mock.schema.json'],
    ['/repo/mock-app', 'one'],
    ['/repo/mock-app', 'one/.schema'],
    ['/repo/mock-app', 'one/.schema/mock.schema.json'],
    ['/repo/mock-app/one', '.schema'],
    ['/repo/mock-app/one', '.schema/mock.schema.json'],
    ['/repo/mock-app/one', 'one'],
    ['/repo/mock-app/one', 'one/.schema'],
    ['/repo/mock-app/one', 'one/.schema/mock.schema.json'],
  ]);

  await ws.schemasChanged(['/repo/elsewhere/mock.schema.json']);
  assert.equal(unavailable(onePath), true);

  files[schemaPath] = JSON.stringify({ properties: { name: { description: 'version one' } } });
  await ws.schemasChanged([schemaPath]);
  assert.equal(unavailable(onePath), false);
  assert.equal(unavailable(commonPath), false);
  assert.equal(ws.hover(`file://${onePath}`, at(files[onePath], 'name')).contents.value, '```\nname    [optional]\n```\n\nversion one');
  assert.equal(ws.cache.schemaCount(), 1);

  const reads = ws.reads.length;
  await ws.schemasChanged([schemaPath]);
  assert.ok(ws.reads.length > reads);
  assert.equal(ws.cache.schemaCount(), 1);

  files[schemaPath] = JSON.stringify({ properties: { name: { description: 'version two' } } });
  await ws.schemasChanged([schemaPath]);
  const versionTwo = '```\nname    [optional]\n```\n\nversion two';
  assert.equal(ws.hover(`file://${onePath}`, at(files[onePath], 'name')).contents.value, versionTwo);
  assert.equal(ws.hover(`file://${commonPath}`, at(files[commonPath], 'name')).contents.value, versionTwo);
  assert.equal(ws.cache.schemaCount(), 2);

  delete files[schemaPath];
  await ws.schemasChanged(['/repo/mock-app/one/.schema']);
  assert.equal(unavailable(onePath), true);
});

test('a schema path with glob characters is watched literally from a folder that exists', async () => {
  const files = { '/repo/[mock]/mock.yml': '# yaml-language-server: $schema=../{schema}*.json\nname: plain\n' };
  const ws = workspace(files, async () => null);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync('file:///repo/[mock]/mock.yml', '/repo/[mock]/mock.yml', files['/repo/[mock]/mock.yml']);
  assert.deepEqual(ws.schemaWatchTargets(), [{ base: '/repo', pattern: '[{]schema[}][*].json' }]);
  const nested = '# yaml-language-server: $schema=.terraform/[x]/s.json\nname: plain\n';
  await ws.sync('file:///repo/[mock]/mock.yml', '/repo/[mock]/mock.yml', nested);
  assert.deepEqual(ws.schemaWatchTargets(), [
    { base: '/repo/[mock]', pattern: '.terraform' },
    { base: '/repo/[mock]', pattern: '.terraform/[[]x[]]' },
    { base: '/repo/[mock]', pattern: '.terraform/[[]x[]]/s.json' },
  ]);
});

test('a reanalyzed stack names every open document in it, fold buffers included', async () => {
  const files = { [common]: 'name: plain\n', [one]: 'name: plain\n' };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${one}`, one, files[one]);
  const stackId = ws.foldsFor(one).stackId;
  const foldBuffer = `yaml-dsl-fold:${encodeURIComponent(stackId)}/one`;
  await ws.sync(foldBuffer, foldBuffer, 'name: plain\n');
  await ws.sync('yaml-dsl-fold:%2Frepo%2Fother/one', 'yaml-dsl-fold:%2Frepo%2Fother/one', 'name: plain\n');
  await ws.sync('file:///repo/unclaimed.txt', '/repo/unclaimed.txt', 'plain\n');
  await ws.sync(`file://${common}`, common, 'name: edited\n');
  assert.deepEqual(ws.takeReanalyzedUris().sort(), [`file://${common}`, `file://${one}`, foldBuffer].sort());
  assert.deepEqual(ws.takeReanalyzedUris(), []);
  await ws.sync(`file://${common}`, common, 'name: edited\n');
  assert.deepEqual(ws.takeReanalyzedUris(), []);
});

test('each reference is classified local, external, or error', async () => {
  const files = {
    [common]: 'locals:\n  db: mock-value\nmocktype:\n  primary:\n    label: local.db\n',
    [two]: 'mocktype:\n  replica:\n    source: ref mocktype.primary\n    gone: ref mocktype.nope\n    self: ref mocktype.replica\n',
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${two}`, two, files[two]);
  await ws.sync(`file://${common}`, common, files[common]);
  const classesOf = (uri, text) => ws.references(uri).map((reference) => [
    text.split('\n')[reference.range.start.line].slice(reference.range.start.character, reference.range.end.character),
    reference.kind,
  ]);
  assert.deepEqual(classesOf(`file://${two}`, files[two]), [
    ['ref mocktype.primary', 'external'],
    ['ref mocktype.nope', 'error'],
    ['ref mocktype.replica', 'local'],
  ]);
  assert.deepEqual(classesOf(`file://${common}`, files[common]), [['local.db', 'local']]);
  const stackId = ws.foldsFor(two).stackId;
  const folded = ws.references(`yaml-dsl-fold:${encodeURIComponent(stackId)}/two`);
  assert.deepEqual(folded.map((reference) => reference.kind).sort(), ['error', 'external', 'external', 'local']);
  const commonOnly = ws.references(`yaml-dsl-fold:${encodeURIComponent(stackId)}/one`);
  assert.deepEqual(commonOnly.map((reference) => reference.kind), ['local']);
  assert.equal(ws.references('yaml-dsl-fold:%2Frepo%2Fmissing/one'), null);
  assert.equal(ws.references('file:///repo/not-open.yml'), null);
  await ws.sync('file:///repo/unclaimed.txt', '/repo/unclaimed.txt', 'plain\n');
  assert.equal(ws.references('file:///repo/unclaimed.txt'), null);
  assert.equal(ws.references(`yaml-dsl-fold:${encodeURIComponent(stackId)}/one`).length, 1);
});

test('completion offers what the file\'s fold sees, written as each reference rule reads it', async () => {
  const files = {
    [common]: 'locals:\n  db: mock-value\nmocktype:\n  primary:\n    label: local.db\n',
    [one]: 'mocktype:\n  replica: {}\n  per_env: {}\n  only_one: {}\n',
    [two]: 'mocktype:\n  replica: {}\n  per_env: {}\n',
    [three]: 'mocktype:\n  per_env: {}\n',
    [four]: 'mocktype:\n  per_env: {}\n',
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const after = (text, needle) => {
    const index = text.indexOf(needle) + needle.length;
    const line = text.slice(0, index).split('\n').length - 1;
    return { line, character: index - text.lastIndexOf('\n', index - 1) - 1 };
  };
  const labels = (filePath, text, needle) => ws
    .completion(`file://${filePath}`, after(text, needle))
    .map((item) => item.label);
  const oneText = `${files[one]}  wired:\n    source: ref \n    label: local.\n    note: "a \${local.d"\n    key_being_typed\n`;
  await ws.sync(`file://${one}`, one, oneText);
  assert.deepEqual(labels(one, oneText, 'source: ref '), [
    'ref mocktype.replica',
    'ref mocktype.per_env',
    'ref mocktype.only_one',
    'ref mocktype.wired',
    'ref mocktype.primary',
  ]);
  assert.deepEqual(labels(one, oneText, 'label: local.'), ['local.db']);
  assert.deepEqual(labels(one, oneText, '${local.d').sort(), ['${env}', '${local.db}']);
  const builtin = ws.completion(`file://${one}`, after(oneText, '${local.d')).find((entry) => entry.label === '${env}');
  assert.deepEqual([builtin.kind, builtin.detail, builtin.documentation], ['builtin', 'GLOBAL scope', '']);
  assert.deepEqual(labels(one, oneText, 'key_being_typed').sort(), ['label', 'source']);
  const item = ws.completion(`file://${one}`, after(oneText, 'source: ref '))
    .find((entry) => entry.label === 'ref mocktype.primary');
  assert.deepEqual(item.range.start, after(oneText, 'source: '));
  assert.deepEqual(item.range.end, after(oneText, 'source: ref '));
  assert.equal(item.detail, 'mock-stack/mock.yml');
  assert.match(item.documentation, /^```yaml-dsl\n {2}primary:/);

  const commonText = `${files[common]}    source: re\n    closed: "\${local.db}"\n`;
  await ws.sync(`file://${common}`, common, commonText);
  assert.deepEqual(labels(common, commonText, 'source: re'), ['ref mocktype.primary', 'ref mocktype.per_env']);
  assert.deepEqual(labels(common, commonText, '${local.db}'), []);

  const sparse = workspace({ [common]: files[common], [one]: files[one] }, async () => schema);
  await sparse.setConfigs([{ text: config, dir: '/repo' }]);
  await sparse.sync(`file://${common}`, common, commonText);
  const sparseLabels = sparse
    .completion(`file://${common}`, after(commonText, 'source: re'))
    .map((entry) => entry.label);
  assert.deepEqual(sparseLabels, [
    'ref mocktype.primary',
    'ref mocktype.replica',
    'ref mocktype.per_env',
    'ref mocktype.only_one',
  ]);
  assert.deepEqual(ws.completion('file:///repo/not-open.yml', { line: 0, character: 0 }), []);
  await ws.sync('file:///repo/unclaimed.txt', '/repo/unclaimed.txt', 'plain\n');
  assert.deepEqual(ws.completion('file:///repo/unclaimed.txt', { line: 0, character: 0 }), []);
  assert.deepEqual(ws.completion(`file://${one}`, { line: 99, character: 0 }), []);
});

test('completion in a DSL without layers offers the whole file', async () => {
  const flat = configText(dslEntry('flat', {
    file_includes: ['**/flat.yml'],
    scopes: { local: scope() },
    declarations: [declaration('$.locals.*', 'local')],
    references: [reference('^local\\.(?<name>[a-z]+)$', 'local')],
  }));
  const text = 'locals:\n  db: one\nuse: local.\n';
  const ws = workspace({ '/repo/flat.yml': text }, async () => null);
  await ws.setConfigs([{ text: flat, dir: '/repo' }]);
  await ws.sync('file:///repo/flat.yml', '/repo/flat.yml', text);
  assert.deepEqual(ws.completion('file:///repo/flat.yml', { line: 2, character: 11 }).map((item) => item.label), ['local.db']);
});

test('an entry keyed by a local is offered by the local\'s value, as a ref names it', async () => {
  const files = {
    [common]: 'locals:\n  alias: mock-thing\nmocktype:\n  name ${local.alias}: {}\n  name ${local.missing}: {}\n',
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const text = `${files[common]}  user:\n    source: ref \n`;
  await ws.sync(`file://${common}`, common, text);
  const labels = ws.completion(`file://${common}`, { line: 6, character: 16 }).map((item) => item.label);
  assert.deepEqual(labels, ['ref mocktype.mock_thing', 'ref mocktype.user']);
});

test('a local the overlay overrides names the entry the overlay\'s fold sees', async () => {
  const files = {
    [common]: 'locals:\n  alias: common-thing\nmocktype:\n  name ${local.alias}: {}\n',
    [one]: 'locals:\n  alias: overlay-thing\nmocktype:\n  user:\n    source: ref \n',
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${one}`, one, files[one]);
  const labels = ws.completion(`file://${one}`, { line: 4, character: 16 }).map((item) => item.label);
  assert.deepEqual(labels, ['ref mocktype.user', 'ref mocktype.overlay_thing']);
});

test('an overlay\'s own declaration wins over the common layer\'s', async () => {
  const files = {
    [common]: 'locals:\n  db: common-value\n',
    [one]: 'locals:\n  db: overlay-value\nuse: local.db\n',
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${one}`, one, files[one]);
  assert.equal(ws.definition(`file://${one}`, at(files[one], 'local.db')).path, one);
  assert.match(ws.hover(`file://${one}`, at(files[one], 'local.db')).contents.value, /overlay-value/);
  assert.deepEqual(ws.references(`file://${one}`).map((reference) => reference.kind), ['local']);
});

test('a common layer ref resolves in each overlay whose merge keeps it, and leads to each declaration', async () => {
  const files = {
    [common]: [
      'locals:',
      '  decrypter: ref mockdata.kms_key',
      '  invokers: ref mockdata.execution_role',
      '  partial: ref mockdata.three_only',
      '  replaced: ref mockdata.common_only',
      'mockdata:',
      '  common_only:',
      '    label: mock-label',
      '',
    ].join('\n'),
    [one]: [
      'locals:',
      '  decrypter: ref mockdata.one_key',
      '  replaced: mock-one',
      'mockdata:',
      '  one_key: {}',
      '  execution_role: {}',
      '',
    ].join('\n'),
    [two]: [
      'locals:',
      '  invokers: ref mockdata.two_role',
      '  replaced: mock-two',
      'mockdata:',
      '  kms_key: {}',
      '  two_role: {}',
      '',
    ].join('\n'),
    [three]: [
      'locals:',
      '  replaced: mock-three',
      'mockdata:',
      '  kms_key: {}',
      '  execution_role: {}',
      '  three_only: {}',
      '',
    ].join('\n'),
    [four]: [
      'locals:',
      '  replaced: mock-four',
      'mockdata:',
      '  kms_key: {}',
      '  execution_role: {}',
      '',
    ].join('\n'),
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  const commonUri = `file://${common}`;
  await ws.sync(commonUri, common, files[common]);
  const linkTargets = ws.links(commonUri).map((link) => link.targets.map((target) => target.path));
  assert.deepEqual(linkTargets, [
    [two, three, four],
    [one, three, four],
  ]);
  const sectionTitles = (needle) => [...ws.hover(commonUri, at(files[common], needle)).contents.value
    .matchAll(/^\[([^\]]+)\]\(file:\/\/[^)]+#L(\d+)\)$/gm)].map((found) => `${found[1]}:${found[2]}`);
  assert.deepEqual(sectionTitles('ref mockdata.kms_key'), ['two:5', 'three:4', 'four:4']);
  assert.deepEqual(sectionTitles('ref mockdata.execution_role'), ['one:6', 'three:5', 'four:5']);
  assert.match(ws.hover(commonUri, at(files[common], 'ref mockdata.common_only')).contents.value, /^\[mock-stack\/mock\.yml:7\]/);
  assert.equal(ws.definition(commonUri, at(files[common], 'ref mockdata.kms_key')), null);
  assert.equal(ws.definition(commonUri, at(files[common], 'ref mockdata.three_only')), null);
  assert.equal(ws.definition(commonUri, at(files[common], 'ref mockdata.common_only')).path, common);
  assert.deepEqual(ws.references(commonUri).map((reference) => reference.kind), [
    'external',
    'external',
    'error',
    'local',
  ]);
  const hover = ws.hover(commonUri, at(files[common], 'ref mockdata.kms_key'));
  assert.doesNotMatch(hover.contents.value, /Invalid reference/);
});

test('a file below an overlay directory takes the common layer above it, shared with the adjacent stack', async () => {
  const nestedOne = `${root}/one/config/mock.yml`;
  const files = {
    [common]: 'locals:\n  db: mock-value\n',
    [one]: 'use: local.db\n',
    [nestedOne]: 'use: local.db\n',
  };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${nestedOne}`, nestedOne, files[nestedOne]);
  await ws.sync(`file://${one}`, one, files[one]);
  assert.equal(ws.definition(`file://${nestedOne}`, at(files[nestedOne], 'local.db')).path, common);
  assert.deepEqual(ws.foldsFor(nestedOne), {
    stackId: `${common}#config`,
    overlayNames: ['one'],
    overlayLabels: ['one'],
  });
  const renamed = 'locals:\n  other: mock-value\n';
  await ws.sync(`file://${common}`, common, renamed);
  assert.deepEqual(ws.references(`file://${nestedOne}`).map((reference) => reference.kind), ['error']);
  assert.deepEqual(ws.references(`file://${one}`).map((reference) => reference.kind), ['error']);
});

test('every placeholder is a builtin or a reference the config allows, and the rest are problems', async () => {
  const text = [
    'mocktype:',
    '  name ${env}_${local.db}:',
    '    a: "${env} ${local.db} ${local.nope}"',
    '    b: ${envv}',
    '    c: ${ref mocktype.x}',
    '',
  ].join('\n');
  const files = { [common]: `locals:\n  db: mock-value\n${text}` };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, files[common]);
  const problems = ws.problems(`file://${common}`).map((problem) => problem.message);
  assert.deepEqual(problems.filter((message) => message.includes('placeholder')), [
    'a reference matching ^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+) is not allowed as whole_placeholder',
  ]);
  const classes = ws.references(`file://${common}`).map((reference) => reference.kind);
  assert.deepEqual(classes.sort(), ['builtin', 'builtin', 'error', 'error', 'local', 'local']);
  const tokens = ws.semanticTokens(`file://${common}`);
  const line = (number) => tokens
    .filter((token) => token.line === number)
    .map((token) => [token.character, token.length, token.type, token.modifiers.join()]);
  assert.deepEqual(line(3), [
    [7, 2, 'operator', ''],
    [9, 3, 'variable', 'defaultLibrary'],
    [12, 1, 'operator', ''],
    [14, 2, 'operator', ''],
    [16, 6, 'keyword', ''],
    [22, 2, 'variable', ''],
    [24, 1, 'operator', ''],
  ]);
  assert.deepEqual(ws.semanticTokens('file:///repo/not-open.yml'), []);
  const stackId = ws.foldsFor(common).stackId;
  assert.ok(ws.semanticTokens(`yaml-dsl-fold:${encodeURIComponent(stackId)}/one`).length > 0);
  assert.equal(ws.decorations('file:///repo/not-open.yml').references, null);
});

test('a ref with a builtin in its name keeps the builtin\'s own tokens', async () => {
  const text = 'mocktype:\n  user:\n    source: ref mocktype.${env}_thing\n';
  const ws = workspace({ [common]: text }, async () => schema);
  const placeholderNames = configText(sampleEntry({ references: entryReferences('[a-z0-9_${}]+') }));
  await ws.setConfigs([{ text: placeholderNames, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const tokens = ws.semanticTokens(`file://${common}`).map((token) => [token.character, token.length, token.type]);
  assert.deepEqual(tokens, [
    [12, 4, 'keyword'],
    [16, 8, 'type'],
    [24, 1, 'operator'],
    [25, 2, 'operator'],
    [27, 3, 'variable'],
    [30, 1, 'operator'],
    [31, 6, 'variable'],
  ]);
});

test('opening a file whose stack is already analyzed still asks for a repaint', async () => {
  const files = { [common]: 'name: plain\n' };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await visitStack(ws, common);
  ws.takeReanalyzedUris();
  await ws.sync(`file://${common}`, common, files[common]);
  assert.deepEqual(ws.takeReanalyzedUris(), [`file://${common}`]);
  await ws.sync(`file://${common}`, common, files[common]);
  assert.deepEqual(ws.takeReanalyzedUris(), []);
  ws.close(`file://${common}`);
  await ws.sync(`file://${common}`, common, files[common]);
  ws.close(`file://${common}`);
  assert.deepEqual(ws.takeReanalyzedUris(), []);
});

test('a request for an open file waits for its analysis, and builds a stack nobody queued', async () => {
  const files = { [common]: 'locals:\n  db: mock-value\nuse: local.db\n' };
  const ws = workspace(files, async () => schema);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  ws.setCacheCapacities({ stackCapacity: 8, schemaCapacity: 32 });
  const opening = ws.sync(`file://${common}`, common, files[common]);
  await ws.whenAnalyzed(`file://${common}`);
  assert.deepEqual(ws.references(`file://${common}`).map((reference) => reference.kind), ['local']);
  await opening;
  const stackId = ws.foldsFor(common).stackId;
  for (let index = 0; index < 9; index += 1) await visitStack(ws, `/repo/other-${index}/mock.yml`);
  assert.ok(ws.cache.get(stackId));
  ws.cache.drop(stackId);
  await ws.whenAnalyzed(`file://${common}`);
  assert.ok(ws.cache.get(stackId));
  await ws.whenAnalyzed(`yaml-dsl-fold:${encodeURIComponent(stackId)}/one`);
  await ws.whenAnalyzed('file:///repo/not-open.yml');
  await ws.sync('file:///repo/unclaimed.txt', '/repo/unclaimed.txt', 'plain\n');
  await ws.whenAnalyzed('file:///repo/unclaimed.txt');
});

function functionsConfig(definitions) {
  return configText(sampleEntry({ function: markerFunction({ definitions }) }, 'first_word'));
}

const functionsSchema = JSON.stringify({
  ...JSON.parse(schema),
  'x-yaml-dsl-functions': {
    ssm: {
      description: 'Reads the mock parameter.',
      arguments: [
        { name: 'parameter', type: 'text', required: true, repeated: false, description: 'The mock parameter name.' },
      ],
      return: { type: 'text', description: 'The mock parameter\'s value.' },
    },
  },
});

test('calls are checked against Terraform and the schema once both vocabularies are known', async () => {
  const text = [
    'locals:',
    '  db fn.ssm: /mock/key',
    '  up fn.upper: x',
    '  bad fn.nope: x',
    'mocktype:',
    '  user:',
    '    label: local.db',
    '    source: "a ${local.db}"',
    '',
  ].join('\n');
  let answer;
  const ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? text : null),
    fetchText: async () => functionsSchema,
    terraformFunctions: () => new Promise((resolve) => { answer = resolve; }),
  });
  const loaded = [];
  ws.onVocabularyLoaded(() => loaded.push('terraform'));
  await ws.setConfigs([{ text: functionsConfig(['terraform', 'schema']), dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const messages = () => ws.problems(`file://${common}`).map((problem) => problem.message);
  assert.deepEqual(messages(), ['a call result is not allowed as placeholder_in_text']);
  answer({ function_signatures: { upper: { return_type: 'string', parameters: [{ name: 'str', type: 'string' }] } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loaded, ['terraform']);
  await ws.whenAnalyzed(`file://${common}`);
  assert.deepEqual(messages(), ['unknown function nope', 'a call result is not allowed as placeholder_in_text']);
  assert.equal(
    ws.hover(`file://${common}`, at(text, 'ssm')).contents.value,
    '```\nssm(parameter: text): text\n```\n\nReads the mock parameter.\n\n- `parameter`: The mock parameter name.'
      + '\n\n*Returns:* The mock parameter\'s value.',
  );
  assert.equal(
    ws.hover(`file://${common}`, at(text, 'upper')).contents.value,
    '```\nupper(str: text): text\n```\n\n*Returns:* `text`',
  );
  assert.equal(ws.hover(`file://${common}`, at(text, 'nope')).contents.value, 'nope');
  const callTokens = ws.semanticTokens(`file://${common}`)
    .filter((token) => token.line === 1)
    .map((token) => [token.character, token.length, token.type]);
  assert.deepEqual(callTokens, [[5, 3, 'keyword'], [8, 3, 'function']]);
  const typing = text.replace('  bad fn.nope: x', '  e fn.u: x');
  await ws.sync(`file://${common}`, common, typing);
  const offered = ws.completion(`file://${common}`, { line: 3, character: 8 });
  assert.deepEqual(offered.map((item) => [item.label, item.kind, item.detail]), [
    ['fn.upper', 'function', 'upper(str: text): text'],
    ['fn.ssm', 'function', 'ssm(parameter: text): text'],
  ]);
});

test('a schema that publishes nothing at the vocabulary pointer is a problem on the modeline', async () => {
  const text = 'locals:\n  db fn.ssm: /mock/key\n';
  const ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? text : null),
    fetchText: async () => schema,
  });
  await ws.setConfigs([{ text: functionsConfig(['schema']), dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const problems = ws.problems(`file://${common}`);
  assert.deepEqual(problems.map((problem) => [problem.message, problem.range.start.line]), [
    ['the schema publishes no #/x-yaml-dsl-functions', 0],
  ]);
});

test('with no splat operator, a call written as a tag binds its arguments by the table, '
  + 'and a reference standing as an argument is not typed', async () => {
  const text = [
    'Resources:',
    '  MockBucket:',
    '    Name: !Join ["-", [mock, !Ref MockBucket]]',
    '    Encoded:',
    '      Fn::Base64: !Ref MockBucket',
    '    Broken: !Join mock-text',
    '',
  ].join('\n');
  const tableSchema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-yaml-dsl-functions': {
      Join: {
        description: 'Joins the values by the delimiter.',
        arguments: [
          { name: 'delimiter', type: 'text', required: true, repeated: false, description: 'The mock delimiter.' },
          { name: 'values', type: 'list', required: true, repeated: false, description: 'The mock values.' },
        ],
        return: { type: 'text', description: 'The joined text.' },
      },
      Base64: {
        description: 'Encodes the text.',
        arguments: [{ name: 'text', type: 'text', required: true, repeated: false, description: 'The mock text.' }],
      },
    },
  });
  const tableConfig = configText(dslEntry('mock-template', {
    schema_search_paths: ['https://example.test/fallback.json'],
    tag_keys: [{ tag: '!Join', key: 'Fn::Join' }, { tag: '!Ref', key: 'Ref' }],
    scopes: { LOGICAL_ID: scope() },
    declarations: [declaration('$.Resources.*', 'LOGICAL_ID')],
    references: [reference('^!Ref (?<name>[A-Za-z0-9]+)$', 'LOGICAL_ID')],
    function: {
      definitions: ['schema'],
      call_result_reference_positions: [],
      calls_not_allowed_at: [],
      marker_function: { call_marker: 'Fn::', splat_operator: null, calls_without_name_allowed: true },
    },
  }));
  const ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? text : null),
    fetchText: async () => tableSchema,
  });
  await ws.setConfigs([{ text: tableConfig, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const problems = ws.problems(`file://${common}`).filter((problem) => problem.severity === 'error');
  assert.deepEqual(problems.map((problem) => [problem.message, problem.range.start.line]), [
    ['Join takes 2 arguments, given 1', 5],
  ]);
  assert.equal(
    ws.hover(`file://${common}`, at(text, '!Join')).contents.value,
    '```\nJoin(delimiter: text, values: list): text\n```\n\nJoins the values by the delimiter.\n\n'
      + '- `delimiter`: The mock delimiter.\n- `values`: The mock values.\n\n*Returns:* The joined text.',
  );
});

test('a macro the schema\'s table publishes is called beside sibling keys by its suffixed name, '
  + 'and hover documents what it expands to', async () => {
  const text = [
    'Resources:',
    '  Fn::ForEach::Topics:',
    '    - TopicName',
    '    - [MockA, MockB]',
    '    - TopicMock:',
    '        Type: mock-type',
    '  MockBucket:',
    '    Type: mock-type',
    '  Fn::ForEach::Queues: [QueueName, [MockC]]',
    '',
  ].join('\n');
  const macroArgument = (name, type) => ({
    name,
    type,
    required: true,
    repeated: false,
    description: `The mock ${name}.`,
  });
  const tableSchema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-yaml-dsl-functions': {
      ForEach: {
        description: 'Repeats the mock fragment.',
        arguments: [
          macroArgument('identifier', 'text'),
          macroArgument('collection', 'list'),
          macroArgument('fragment', 'map'),
        ],
        macro: { kind: 'loop', name_suffix_pattern: '::[A-Za-z0-9]+' },
      },
    },
  });
  const tableConfig = configText(dslEntry('mock-template', {
    schema_search_paths: ['https://example.test/fallback.json'],
    scopes: { LOGICAL_ID: scope() },
    declarations: [declaration('$.Resources.*', 'LOGICAL_ID')],
    function: {
      definitions: ['schema'],
      call_result_reference_positions: [],
      calls_not_allowed_at: [],
      marker_function: { call_marker: 'Fn::', splat_operator: null, calls_without_name_allowed: true },
    },
  }));
  const ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? text : null),
    fetchText: async () => tableSchema,
  });
  await ws.setConfigs([{ text: tableConfig, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const problems = ws.problems(`file://${common}`).filter((problem) => problem.severity === 'error');
  assert.deepEqual(problems.map((problem) => [problem.message, problem.range.start.line]), [
    ['ForEach takes 3 arguments, given 2', 8],
  ]);
  assert.equal(
    ws.hover(`file://${common}`, at(text, 'ForEach::Topics')).contents.value,
    '```\nmacro ForEach(identifier: text, collection: list, fragment: map)\n```\n\nRepeats the mock fragment.\n\n'
      + '- `identifier`: The mock identifier.\n- `collection`: The mock collection.\n'
      + '- `fragment`: The mock fragment.\n\n'
      + '*Expands to:* `fragment` once per item of `collection`, the item standing for `identifier`.',
  );
});

test('an include\'s key is a function_call macro call, at its marked and unmarked keys, '
  + 'its callee\'s arguments bound by name and its callee documented', async () => {
  const text = [
    'Transform: [Mock::Registered, Mock::Include]',
    'Resources:',
    '  Fn::Transform:',
    '    Name: Mock::Include',
    '    Parameters: { Location: s3://mock-bucket/mock.yaml }',
    '  MockBucket:',
    '    Fn::Transform: { Name: Mock::Registered }',
    '    Other: x',
    '',
  ].join('\n');
  const mockArgument = (name, type, required) => ({
    name,
    type,
    required,
    repeated: false,
    description: `The mock ${name}.`,
  });
  const includeSchema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    'x-yaml-dsl-functions': {
      'Mock::Include': {
        description: 'Includes the mock snippet.',
        arguments: [mockArgument('Location', 'text', true)],
        macro: { kind: 'merge' },
      },
      Transform: {
        description: 'Calls the mock macro.',
        arguments: [mockArgument('Name', 'text', true), mockArgument('Parameters', 'map', false)],
        macro: { kind: 'function_call', unmarked_key_paths: ['$.Transform'] },
      },
    },
  });
  const includeConfig = configText(dslEntry('mock-template', {
    schema_search_paths: ['https://example.test/fallback.json'],
    layers: {
      common_layer_discovery: 'overlay_includes',
      overlay_includes: [{
        key_paths: ["$..['Fn::Transform']"],
        value_conditions: [{ key: 'Name', value: 'Mock::Include' }],
        location_path: '$.Parameters.Location',
        location_mappings: [],
      }],
      duplicate_check: { depth: 1, key_depths: {}, skip_keys: [] },
    },
    function: {
      definitions: ['schema'],
      call_result_reference_positions: [],
      calls_not_allowed_at: [],
      marker_function: { call_marker: 'Fn::', splat_operator: null, calls_without_name_allowed: true },
    },
  }));
  const ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? text : null),
    fetchText: async () => includeSchema,
  });
  await ws.setConfigs([{ text: includeConfig, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const problems = ws.problems(`file://${common}`).filter((problem) => problem.severity === 'error');
  assert.deepEqual(problems.map((problem) => [problem.message, problem.range.start.line]), [
    ['Mock::Include needs argument Location', 0],
  ]);
  const hoverAt = (needle) => ws.hover(`file://${common}`, at(text, needle)).contents.value;
  const transformSignature = /^```\nmacro Transform\(Name: text, Parameters\?: map\)\n```/;
  assert.match(hoverAt('Transform: ['), transformSignature);
  assert.match(hoverAt('Transform:\n    Name'), transformSignature);
  const includeDocumentation = hoverAt('Mock::Include\n');
  assert.match(includeDocumentation, /^```\nmacro Mock::Include\(Location: text\)\n```\n\nIncludes the mock snippet\./);
  const includeExpansion = /\*Expands to:\* the map holding the call, merged over the content at `Location`\./;
  assert.match(includeDocumentation, includeExpansion);
});

test('a function table in the deprecated argument-list form is an info on the modeline, its calls still checked', async () => {
  const text = 'locals:\n  db fn.ssm: /mock/key\n  bad fn.ssm*: [1, 2]\n';
  const listedSchema = JSON.stringify({
    ...JSON.parse(schema),
    'x-yaml-dsl-functions': { ssm: [{ name: 'parameter', type: 'text', required: true, repeated: false }] },
  });
  const ws = createWorkspace({
    readFile: async (filePath) => (filePath === common ? text : null),
    fetchText: async () => listedSchema,
  });
  await ws.setConfigs([{ text: functionsConfig(['schema']), dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, text);
  const problems = ws.problems(`file://${common}`);
  assert.deepEqual(problems.map((problem) => [problem.message, problem.range.start.line, problem.severity]), [
    ['ssm takes 1 arguments, given 2', 2, 'error'],
    [
      '#/x-yaml-dsl-functions maps a function straight to its arguments, a deprecated form: '
        + 'map each function to its description, arguments and return',
      0,
      'info',
    ],
  ]);
});

test('a changed config reaches every resident stack, and drops the stacks it no longer claims', async () => {
  const otherCommon = '/repo/other-stack/mock.yml';
  const files = { [common]: 'locals:\n  db: x\n', [one]: 'a: 1\n', [otherCommon]: 'b: 1\n' };
  const ws = workspace(files);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${one}`, one, files[one]);
  await visitStack(ws, otherCommon);
  ws.close(`file://${one}`);
  ws.takeEvicted();
  const narrowed = configText(sampleEntry({ file_includes: ['**/mock-stack/**/mock.yml'] }));
  await ws.setConfigs([{ text: narrowed, dir: '/repo' }]);
  assert.deepEqual(ws.cache.get(common).data.dsl.fileIncludes, ['**/mock-stack/**/mock.yml']);
  assert.equal(ws.cache.get(otherCommon), null);
  assert.deepEqual(ws.takeEvicted(), [otherCommon]);
});

test('closing a layer\'s tab reads the layer from disk again, so a file gone from disk leaves the stack', async () => {
  const disk = { [common]: 'locals:\n  db: mock-value\n', [one]: 'use: local.db\n' };
  const ws = workspace(disk);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, disk[common]);
  await ws.sync(`file://${one}`, one, disk[one]);
  delete disk[common];
  await ws.layersChanged([common]);
  assert.equal(ws.cache.get(common).data.files.has(common), true);
  await ws.close(`file://${common}`);
  assert.equal(ws.cache.get(common).data.files.has(common), false);
  assert.deepEqual(ws.references(`file://${one}`).map((reference) => reference.kind), ['error']);
});

test('closing a layer\'s tab whose text matches the disk changes nothing', async () => {
  const disk = { [common]: 'locals:\n  db: mock-value\n', [one]: 'use: local.db\n' };
  const ws = workspace(disk);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, disk[common]);
  await ws.sync(`file://${one}`, one, disk[one]);
  const before = ws.cache.get(common).data;
  await ws.close(`file://${common}`);
  assert.equal(ws.cache.get(common).data, before);
});

const renameFiles = {
  [common]: [
    'locals:',
    '  db: mock-value',
    'mocktype:',
    '  name mock-thing:',
    '    label: local.db',
    '  other-thing:',
    '    label: "${local.db}-${env}"',
    '',
  ].join('\n'),
  [one]: [
    'locals:',
    '  db: mock-one',
    'mocktype:',
    '  replica:',
    '    source: ref mocktype.mock_thing.label',
    '',
  ].join('\n'),
};

function place(text, needle, shift) {
  const start = at(text, needle);
  return { line: start.line, character: start.character + shift };
}

function rangeOf(text, needle) {
  const start = at(text, needle);
  return { start, end: { line: start.line, character: start.character + needle.length } };
}

function offsetAt(text, position) {
  const lines = text.split('\n');
  return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
}

function textsAfter(files, edit) {
  const texts = { ...files };
  for (const change of edit.documentChanges) {
    const filePath = change.textDocument.uri.replace(/^file:\/\//, '');
    const text = texts[filePath];
    const edits = change.edits
      .map((item) => ({ start: offsetAt(text, item.range.start), end: offsetAt(text, item.range.end), text: item.newText }))
      .sort((left, right) => right.start - left.start);
    texts[filePath] = edits.reduce((result, item) => result.slice(0, item.start) + item.text + result.slice(item.end), text);
  }
  return texts;
}

async function renameWorkspace() {
  const ws = workspace(renameFiles);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${common}`, common, renameFiles[common]);
  await ws.sync(`file://${one}`, one, renameFiles[one]);
  return ws;
}

test('renaming a local renames its declaration in every layer and every reference, placeholders included', async () => {
  const ws = await renameWorkspace();
  const at = (needle) => place(renameFiles[common], needle, 2);
  assert.deepEqual(ws.prepareRename(`file://${common}`, at('db: mock-value')).placeholder, 'db');
  const renamed = ws.rename(`file://${common}`, at('db: mock-value'), 'store');
  const texts = textsAfter(renameFiles, renamed.edit);
  assert.match(texts[common], /^ {2}store: mock-value$/m);
  assert.match(texts[common], /label: local\.store$/m);
  assert.match(texts[common], /label: "\$\{local\.store\}-\$\{env\}"/);
  assert.match(texts[one], /^ {2}store: mock-one$/m);
});

test('renaming from a reference shows the name as declared and respells it in every reference', async () => {
  const ws = await renameWorkspace();
  const atRef = place(renameFiles[one], 'mock_thing', 2);
  const prepared = ws.prepareRename(`file://${one}`, atRef);
  assert.equal(prepared.placeholder, 'mock-thing');
  assert.deepEqual(prepared.range, rangeOf(renameFiles[one], 'mock_thing'));
  const texts = textsAfter(renameFiles, ws.rename(`file://${one}`, atRef, 'mock-item').edit);
  assert.match(texts[common], /^ {2}name mock-item:$/m);
  assert.match(texts[one], /source: ref mocktype\.mock_item\.label$/m);
});

test('a rename is refused for a builtin, a name already declared, and a name that does not read back', async () => {
  const ws = await renameWorkspace();
  const commonUri = `file://${common}`;
  const atEnv = place(renameFiles[common], 'env}', 0);
  assert.match(ws.prepareRename(commonUri, atEnv).problem, /builtin/);
  const atThing = place(renameFiles[common], 'mock-thing', 2);
  assert.match(ws.rename(commonUri, atThing, 'other-thing').problem, /mocktype\.other_thing is already declared/);
  assert.match(ws.rename(commonUri, atThing, 'mock item').problem, /does not read back/);
  assert.match(ws.rename(commonUri, atThing, ' ').problem, /empty/);
  assert.equal(ws.prepareRename(commonUri, place(renameFiles[common], 'mock-value', 2)), null);
});

test('a name edited by hand gets a hint renaming it everywhere until it is changed back', async () => {
  const ws = await renameWorkspace();
  const typed = (name) => renameFiles[one].replace('  db: mock-one', `  ${name}: mock-one`);
  await ws.sync(`file://${one}`, one, typed('dbx'));
  await ws.sync(`file://${one}`, one, typed('store'));
  await ws.queueSuggestions(common);
  const renameMarks = () => ws.suggestionMarks(common).files
    .flatMap((file) => file.marks.map((mark) => ({ uri: file.uri, ...mark })))
    .filter((mark) => mark.suggestion.kind === 'rename');
  const [hint] = renameMarks();
  assert.equal(hint.uri, `file://${one}`);
  assert.equal(hint.range.start.line, 1);
  assert.deepEqual(hint.suggestion.rename, {
    oldName: 'db',
    newName: 'store',
    declaredAt: { uri: `file://${one}`, range: hint.range, oldWrittenName: 'db' },
    files: [{ label: 'common layer', count: 3 }],
  });
  const applied = await ws.applySuggestion(common, hint.suggestion.id);
  const handEdited = applied.edit.documentChanges.find((change) => change.textDocument.uri === `file://${one}`);
  assert.deepEqual(handEdited.edits.map((edit) => edit.newText), ['store']);
  const texts = textsAfter({ ...renameFiles, [one]: typed('store') }, applied.edit);
  assert.equal(texts[one], typed('store'));
  assert.match(texts[common], /^ {2}store: mock-value$/m);
  assert.match(texts[common], /\$\{local\.store\}/);
  await ws.sync(`file://${one}`, one, typed('db'));
  await ws.queueSuggestions(common);
  assert.deepEqual(renameMarks(), []);
});

test('copies renamed by hand in two overlays are not a clash, and each offers the rest of the rename', async () => {
  const twoText = 'locals:\n  db: mock-two\n';
  const files = { ...renameFiles, [two]: twoText };
  const ws = workspace(files);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  for (const filePath of [common, one, two]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  await ws.sync(`file://${one}`, one, files[one].replace('  db: mock-one', '  store: mock-one'));
  await ws.sync(`file://${two}`, two, twoText.replace('  db: mock-two', '  store: mock-two'));
  await ws.queueSuggestions(common);
  const hints = ws.suggestionMarks(common).files
    .flatMap((file) => file.marks.map((mark) => [file.uri, mark.suggestion]))
    .filter(([, suggestion]) => suggestion.kind === 'rename');
  assert.deepEqual(hints.map(([uri, suggestion]) => [uri, suggestion.rename.files]), [
    [`file://${one}`, [{ label: 'common layer', count: 3 }]],
    [`file://${two}`, [{ label: 'common layer', count: 3 }]],
  ]);
});

test('a name renamed everywhere is the name a later hand edit is measured from', async () => {
  const ws = await renameWorkspace();
  const atDb = place(renameFiles[common], 'db: mock-value', 2);
  const renamedTexts = textsAfter(renameFiles, ws.rename(`file://${common}`, atDb, 'store').edit);
  for (const filePath of [common, one]) await ws.sync(`file://${filePath}`, filePath, renamedTexts[filePath]);
  await ws.queueSuggestions(common);
  await ws.sync(`file://${one}`, one, renamedTexts[one].replace('  store: mock-one', '  db: mock-one'));
  await ws.queueSuggestions(common);
  const hints = ws.suggestionMarks(common).files.flatMap((file) => file.marks)
    .filter((mark) => mark.suggestion.kind === 'rename');
  assert.deepEqual(hints.map((mark) => [mark.suggestion.rename.oldName, mark.suggestion.rename.newName]), [['store', 'db']]);
});

test('a deprecated key is a warning problem, and the stack\'s report flags the files holding one', async () => {
  const files = {
    '/repo/warn/schema.json': JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { old: { description: 'use kept', deprecated: true }, kept: {} },
    }),
    '/repo/warn/mock.yml': '# yaml-language-server: $schema=schema.json\nold: 1\nkept: 2\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(dslEntry('plain')), dir: '/repo' }]);
  await ws.sync('file:///repo/warn/mock.yml', '/repo/warn/mock.yml', files['/repo/warn/mock.yml']);
  const warnings = ws.problems('file:///repo/warn/mock.yml').filter((problem) => problem.severity === 'warning');
  assert.deepEqual(warnings.map((problem) => problem.message), ['`old` is deprecated: use kept']);
  const [deprecated] = ws.decorations('file:///repo/warn/mock.yml').deprecatedFields;
  assert.deepEqual(deprecated.keyRange, { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } });
  assert.deepEqual(deprecated.fieldRange, { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } });
  const report = ws.suggestionMarks('/repo/warn/mock.yml');
  assert.deepEqual(report.files.map((file) => [file.uri, file.warning]), [['file:///repo/warn/mock.yml', true]]);
});

test('a report carries the hash of each file\'s schema, and a kept file whose schema hash differs is stale', async () => {
  const files = {
    '/repo/warn/schema.json': JSON.stringify({ properties: { kept: {} } }),
    '/repo/warn/mock.yml': '# yaml-language-server: $schema=schema.json\nkept: 1\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(dslEntry('plain')), dir: '/repo' }]);
  await ws.sync('file:///repo/warn/mock.yml', '/repo/warn/mock.yml', files['/repo/warn/mock.yml']);
  const [file] = ws.suggestionMarks('/repo/warn/mock.yml').files;
  assert.match(file.schemaHash, /^[0-9a-f]{64}$/);
  const kept = (schemaHash) => [{ uri: 'file:///repo/warn/mock.yml', schemaHash }];
  assert.deepEqual(await ws.staleKeptSchemaUris(kept(file.schemaHash)), []);
  assert.deepEqual(await ws.staleKeptSchemaUris(kept('mock-old-schema-hash')), ['file:///repo/warn/mock.yml']);
  assert.deepEqual(await ws.staleKeptSchemaUris([{ uri: 'file:///repo/gone/mock.yml', schemaHash: null }]), []);
});

test('a schema changing on disk under a stack no editor holds reports its kept files stale, and an unchanged one does not', async () => {
  const schemaPath = '/repo/warn/schema.json';
  const files = {
    [schemaPath]: JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { old: { deprecated: true }, kept: {} },
    }),
    '/repo/warn/mock.yml': '# yaml-language-server: $schema=schema.json\nold: 1\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(dslEntry('plain')), dir: '/repo' }]);
  const staleReports = [];
  ws.onKeptSchemasChanged((uris) => staleReports.push(uris));
  ws.onSuggestions(() => {});
  await ws.refreshSuggestions(['/repo/warn/mock.yml']);
  assert.ok(ws.schemaWatchTargets().some((watchTarget) => watchTarget.base === '/repo/warn'));
  await ws.schemasChanged([schemaPath]);
  assert.deepEqual(staleReports, []);
  files[schemaPath] = JSON.stringify({ properties: { old: {}, kept: {} } });
  await ws.schemasChanged([schemaPath]);
  assert.deepEqual(staleReports, [['file:///repo/warn/mock.yml']]);
});

test('a stack worked out in the background reports the files holding a deprecated key', async () => {
  const files = {
    '/repo/warn/schema.json': JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { old: { description: 'use kept', deprecated: true }, kept: {} },
    }),
    '/repo/warn/mock.yml': '# yaml-language-server: $schema=schema.json\nold: 1\n',
    '/repo/kept/mock.yml': '# yaml-language-server: $schema=../warn/schema.json\nkept: 1\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: configText(dslEntry('plain')), dir: '/repo' }]);
  const reports = [];
  ws.onSuggestions((stackId) => reports.push(ws.suggestionMarks(stackId)));
  await ws.refreshSuggestions(['/repo/warn/mock.yml', '/repo/kept/mock.yml']);
  const flagged = reports.flatMap((stackReport) => stackReport.files.map((file) => [file.uri, file.warning]));
  assert.deepEqual(flagged, [['file:///repo/warn/mock.yml', true], ['file:///repo/kept/mock.yml', false]]);
});

const taggedPath = '/repo/tagged/mock.yaml';
const taggedSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    Resources: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          Type: { type: 'string' },
          Properties: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                Ref: { type: 'string', description: 'The logical ID a reference reads.' },
                'Fn::GetAtt': { type: 'string' },
                'Fn::Sub': { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
      },
    },
  },
});
const taggedText = [
  'Resources:',
  '  MockBucket:',
  '    Type: Mock::Bucket',
  '  MockQueue:',
  '    Properties:',
  '      Short: !Ref MockBucket',
  '      Long:',
  '        Ref: MockBucket',
  '      Attribute: !GetAtt MockBucket.Arn',
  '      Missing: !Ref MockMissing',
  '      Text: !Sub "arn:${MockBucket}"',
  '      Wrong: !Ref [MockBucket]',
  '',
].join('\n');
const taggedConfig = configText(dslEntry('tagged', {
  file_includes: ['**/mock.yaml'],
  schema_search_paths: ['schema.json'],
  tag_keys: [{ tag: '!Ref', key: 'Ref' }, { tag: '!GetAtt', key: 'Fn::GetAtt' }, { tag: '!Sub', key: 'Fn::Sub' }],
  placeholder: placeholder(),
  scopes: { LOGICAL_ID: scope() },
  declarations: [declaration('$.Resources.*', 'LOGICAL_ID')],
  references: [
    reference('^!Ref (?<name>[A-Za-z0-9]+)$', 'LOGICAL_ID'),
    reference('^!GetAtt (?<name>[A-Za-z0-9]+)\\.', 'LOGICAL_ID', { text_after_name_allowed: true }),
    reference('^(?<name>[A-Za-z0-9]+)$', 'LOGICAL_ID', { positions: inPlaceholders }),
  ],
}));

async function taggedWorkspace(text = taggedText) {
  const ws = workspace({ [taggedPath]: text, '/repo/tagged/schema.json': taggedSchema });
  await ws.setConfigs([{ text: taggedConfig, dir: '/repo' }]);
  await ws.sync(`file://${taggedPath}`, taggedPath, text);
  return ws;
}

test('a reference reads its scalar with its tag, in the short form and under the key the tag stands for', async () => {
  const ws = await taggedWorkspace();
  const uri = `file://${taggedPath}`;
  assert.deepEqual(ws.references(uri).map((reference) => reference.kind), ['local', 'local', 'local', 'error', 'local']);
  const declared = rangeOf(taggedText, 'MockBucket');
  for (const needle of ['!Ref MockBucket', 'Ref: MockBucket', '!GetAtt MockBucket']) {
    const definition = ws.definition(uri, place(taggedText, needle, needle.indexOf('MockBucket') + 1));
    assert.deepEqual(definition.range, declared);
  }
  const renamed = textsAfter({ [taggedPath]: taggedText }, ws.rename(uri, place(taggedText, 'Ref: MockBucket', 6), 'MockStore').edit);
  assert.match(renamed[taggedPath], /^ {2}MockStore:$/m);
  assert.match(renamed[taggedPath], /Short: !Ref MockStore$/m);
  assert.match(renamed[taggedPath], /^ {8}Ref: MockStore$/m);
  assert.match(renamed[taggedPath], /Attribute: !GetAtt MockStore\.Arn$/m);
  assert.match(renamed[taggedPath], /Text: !Sub "arn:\$\{MockStore\}"$/m);
});

test('a tag documents and validates as the key it stands for', async () => {
  const ws = await taggedWorkspace();
  const uri = `file://${taggedPath}`;
  assert.match(ws.hover(uri, place(taggedText, '!Ref MockBucket', 1)).contents.value, /The logical ID a reference reads\./);
  const wrongLine = at(taggedText, 'Wrong').line;
  assert.equal(ws.problems(uri).some((problem) => problem.range.start.line === wrongLine), true);
  const otherLines = ws.problems(uri).filter((problem) => ![wrongLine, at(taggedText, 'MockMissing').line]
    .includes(problem.range.start.line));
  assert.deepEqual(otherLines, []);
});

test('completion offers a name in the short form with its tag and under the key the tag stands for without', async () => {
  const text = `${taggedText}      Typed: !Ref Mock\n      TypedLong:\n        Ref: Mock\n`;
  const ws = await taggedWorkspace(text);
  const uri = `file://${taggedPath}`;
  const labelsAfter = (needle) => {
    const position = place(text, needle, needle.length);
    return ws.completion(uri, position).map((item) => item.label).sort();
  };
  assert.deepEqual(labelsAfter('Typed: !Ref Mock'), ['!Ref MockBucket', '!Ref MockQueue']);
  const longPosition = place(text, '        Ref: Mock\n', '        Ref: Mock'.length);
  const long = ws.completion(uri, longPosition);
  assert.deepEqual(long.map((item) => item.label).sort(), ['MockBucket', 'MockQueue']);
  assert.deepEqual(long[0].range.start, { line: longPosition.line, character: '        Ref: '.length });
});

const branchedSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    mocktype: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { kind: { enum: ['bucket', 'queue'] } },
        if: { properties: { kind: { const: 'bucket' } }, required: ['kind'] },
        then: { properties: { bucket_name: { type: 'string', description: 'The bucket name.' } } },
        else: { properties: { queue_name: { type: 'string', description: 'The queue name.' } } },
        unevaluatedProperties: false,
      },
    },
  },
});

test('hover and completion read the branch the document\'s value selects', async () => {
  const filePath = '/repo/branched/mock.yml';
  const text = [
    '# yaml-language-server: $schema=schema.json',
    'mocktype:',
    '  first:',
    '    kind: bucket',
    '    bucket_name: mock-bucket',
    '  second:',
    '    kind: queue',
    '    bucket_name: mock-stray',
    '    na',
    '',
  ].join('\n');
  const ws = workspace({ [filePath]: text, '/repo/branched/schema.json': branchedSchema });
  await ws.setConfigs([{ text: configText(dslEntry('branched')), dir: '/repo' }]);
  await ws.sync(`file://${filePath}`, filePath, text);
  const uri = `file://${filePath}`;
  assert.match(ws.hover(uri, place(text, 'bucket_name: mock-bucket', 1)).contents.value, /The bucket name\./);
  assert.equal(ws.hover(uri, place(text, 'bucket_name: mock-stray', 1)), null);
  const typed = ws.completion(uri, place(text, '    na\n', '    na'.length)).map((item) => item.label);
  assert.deepEqual(typed.sort(), ['kind', 'queue_name']);
});

test('an overlay\'s hover reads the branch its fold selects, and the common layer one per overlay', async () => {
  const files = {
    [`${root}/schema.json`]: branchedSchema,
    [common]: '# yaml-language-server: $schema=schema.json\nmocktype:\n  shared:\n    kind: bucket\n    bucket_name: mock\n',
    [one]: '# yaml-language-server: $schema=../schema.json\nmocktype:\n  shared:\n    bucket_name: mock-one\n',
    [two]: '# yaml-language-server: $schema=../schema.json\nmocktype:\n  shared:\n    kind: queue\n',
  };
  const ws = workspace(files);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  for (const filePath of [common, one, two]) await ws.sync(`file://${filePath}`, filePath, files[filePath]);
  assert.match(ws.hover(`file://${one}`, place(files[one], 'bucket_name', 1)).contents.value, /The bucket name\./);
  const commonHover = ws.hover(`file://${common}`, place(files[common], 'bucket_name', 1)).contents.value;
  assert.match(commonHover, /one[\s\S]*The bucket name\./);
  assert.match(commonHover, /two[\s\S]*not a field/);
});

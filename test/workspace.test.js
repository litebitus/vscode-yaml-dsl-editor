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

function resourceReferences(refNamePattern = '[a-z0-9_]+') {
  return [
    reference(`^ref (?<type>[a-z0-9_]+)\\.(?<name>${refNamePattern})`, 'RESOURCE', {
      text_after_name_allowed: true,
      scope_group: 'type',
    }),
    reference('^local\\.(?<name>[a-z0-9_]+)$', 'local', { positions: ['whole_scalar', ...inPlaceholders] }),
    reference('^(?<name>[a-z_]+)$', 'GLOBAL', { positions: inPlaceholders }),
  ];
}

function resourcesEntry(fields = {}, localKeyToken = 'all_words') {
  return dslEntry('resources', {
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
      RESOURCE: scope({ named_by_parent_key: true }),
      local: scope(),
    },
    declarations: [
      declaration('$.locals.*', 'local', { key_token: localKeyToken }),
      declaration('$.*.*', 'RESOURCE', {
        skip_keys: ['schema_version', 'cloud', 'env', 'locals', 'outputs', 'sync'],
        exclude_candidates: ['defaults'],
        key_token: 'last_word',
        name_spelling: 'dashes_as_underscores',
      }),
    ],
    references: resourceReferences(),
    ...fields,
  });
}

const config = configText(resourcesEntry());

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
  assert.equal(field.contents.value, '[optional] Mock label.');

  const within = ws.hover(oneUri, at(files[one], 'local.db'));
  assert.match(within.contents.value, /mock-stack\/mock\.yml:\d+/);
  assert.match(within.contents.value, /db:/);

  assert.deepEqual(ws.foldsFor(one), { stackId: common, overlayNames: ['one'] });
  assert.deepEqual(ws.foldsFor(common).overlayNames, ['one', 'two', 'three', 'four']);
  const folded = ws.foldText(common, 'one');
  assert.match(folded, /the one overlay/);
  assert.match(folded, /mock-value/);
  assert.match(ws.foldText(common, 'two'), /the two overlay/);
  const twoFold = ws.foldText(common, 'two');
  assert.match(twoFold, /the two overlay/);

  const foldUri = `yaml-dsl-fold:${encodeURIComponent(common)}/one`;
  assert.ok(ws.links(foldUri).some((link) => link.path === common));
  assert.deepEqual(ws.links('file://missing'), []);
  const foldHover = ws.hover(foldUri, at(folded, 'label'));
  assert.equal(foldHover.contents.value, '[optional] Mock label.');
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
  assert.deepEqual(ws.foldsFor('/missing'), { stackId: null, overlayNames: [] });
  assert.equal(SCHEMA_UNAVAILABLE, 'schema is unavailable');
});

test('a modeline that fails falls through to the published schema', async () => {
  const files = {
    '/repo/only/mock.yml': '# yaml-language-server: $schema=https://example.test/missing.json\nname: plain\n',
    '/repo/bad.json': '[',
    '/repo/good/mock.yml': '# yaml-language-server: $schema=../bad.json\nname: plain\n',
    '/repo/disk/mock.yml': 'name: from-disk\n',
  };
  const ws = workspace(files, async (url) => (url.endsWith('fallback.json') ? schema : null));
  const relative = configText(dslEntry('resources', { schema_search_paths: ['schema.json'] }));
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
  assert.equal(field.contents.value, 'the name');
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
  assert.deepEqual(ws.foldsFor('/repo/note.yml'), { stackId: null, overlayNames: [] });
  assert.equal(ws.foldText('/repo/note.yml', 'one'), '');
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
  const plain = configText(dslEntry('resources', {
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

test('warming loads stacks only into free room and never evicts the stacks being worked on', async () => {
  const plain = configText(dslEntry('resources', {
    layers: {
      overlay_folders: ['one'],
      common_layer_discovery: 'parent',
      duplicate_check: { depth: 3, key_depths: {}, skip_keys: [] },
    },
  }));
  const ws = workspace({}, async () => null);
  await ws.setConfigs([{ text: plain, dir: '/repo' }]);
  ws.setCacheCapacities({ stackCapacity: 2, schemaCapacity: 32 });
  for (const name of ['worked', 'visited']) {
    await ws.setActive(`/repo/${name}/mock.yml`);
  }
  await ws.setActive(null);
  await ws.warm(['/repo/warm-a/mock.yml', '/repo/warm-b/mock.yml', '/repo/warm-c/mock.yml']);
  assert.ok(ws.cache.get('/repo/worked/mock.yml'));
  assert.ok(ws.cache.get('/repo/visited/mock.yml'));
  assert.equal(ws.cache.get('/repo/warm-a/mock.yml'), null);
  assert.deepEqual(ws.takeEvicted(), []);
  ws.setCacheCapacities({ stackCapacity: 3, schemaCapacity: 32 });
  await ws.warm(['/repo/warm-a/mock.yml']);
  assert.ok(ws.cache.get('/repo/warm-a/mock.yml'));
  await ws.setActive('/repo/fresh/mock.yml');
  await ws.setActive(null);
  assert.ok(ws.cache.get('/repo/worked/mock.yml'));
  assert.equal(ws.cache.get('/repo/warm-a/mock.yml'), null);
});

test('a missing modeline walks the schema search path from the file', async () => {
  const found = '/repo/mock-app/one/.schema/sample.schema.json';
  const files = {
    [found]: JSON.stringify({ properties: { name: { description: 'from the side stack' } } }),
  };
  const ws = workspace(files, async () => null);
  await ws.setConfigs([{
    text: configText(dslEntry('resources', {
      schema_search_paths: ['.schema/sample.schema.json', 'one/.schema/sample.schema.json', 1],
    })),
    dir: '/repo',
  }]);
  const common = '/repo/mock-app/mock.yml';
  const text = 'name: plain\n';
  await ws.sync('file://' + common, common, text);
  assert.ok(ws.reads.includes('/repo/mock-app/.schema/sample.schema.json'));
  assert.ok(ws.reads.includes(found));
  assert.equal(ws.hover('file://' + common, at(text, 'name')).contents.value, 'from the side stack');
  const overlayPath = '/repo/mock-app/one/mock.yml';
  await ws.sync('file://' + overlayPath, overlayPath, text);
  assert.equal(ws.hover('file://' + overlayPath, at(text, 'name')).contents.value, 'from the side stack');
  const named = '# yaml-language-server: $schema=missing.json\n' + text;
  await ws.sync('file://' + common, common, named);
  assert.equal(ws.hover('file://' + common, at(named, 'name')).contents.value, 'from the side stack');
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
  await ws.warm([overlay, common, '/other/mock.yml']);
  assert.ok(ws.reads.includes(common));
  assert.ok(ws.reads.includes(overlay));
  assert.ok(ws.reads.includes(schema));
  const marked = ws.reads.length;
  await ws.warm([common]);
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

test('a schema written after the file opened replaces the missing one, and a new version replaces it again', async () => {
  const layered = configText(dslEntry('resources', {
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
  assert.equal(ws.hover(`file://${onePath}`, at(files[onePath], 'name')).contents.value, 'version one');
  assert.equal(ws.cache.schemaCount(), 1);

  const reads = ws.reads.length;
  await ws.schemasChanged([schemaPath]);
  assert.ok(ws.reads.length > reads);
  assert.equal(ws.cache.schemaCount(), 1);

  files[schemaPath] = JSON.stringify({ properties: { name: { description: 'version two' } } });
  await ws.schemasChanged([schemaPath]);
  assert.equal(ws.hover(`file://${onePath}`, at(files[onePath], 'name')).contents.value, 'version two');
  assert.equal(ws.hover(`file://${commonPath}`, at(files[commonPath], 'name')).contents.value, 'version two');
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
  assert.deepEqual(labels(one, oneText, 'key_being_typed'), []);
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

test('a resource keyed by a local is offered by the local\'s value, as a ref names it', async () => {
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

test('a local the overlay overrides names the resource the overlay\'s fold sees', async () => {
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
  assert.deepEqual(ws.foldsFor(nestedOne), { stackId: `${common}#config`, overlayNames: ['one'] });
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
  const placeholderNames = configText(resourcesEntry({ references: resourceReferences('[a-z0-9_${}]+') }));
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
  await ws.warm([common]);
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

test('the active file is analyzed before the warm-up builds anything further', async () => {
  const flatConfig = configText(dslEntry('flat', { file_includes: ['**/flat-*.yml'] }));
  const warmPaths = Array.from({ length: 8 }, (_, index) => `/repo/flat-${index}.yml`);
  const activeFile = '/repo/flat-active.yml';
  const reads = [];
  let ws;
  ws = createWorkspace({
    readFile: async (filePath) => {
      reads.push(filePath);
      if (filePath === warmPaths[2]) {
        ws.sync(`file://${activeFile}`, activeFile, 'name: active\n');
        ws.setActive(activeFile);
      }
      return filePath.endsWith('.yml') ? 'name: plain\n' : null;
    },
    fetchText: async () => null,
  });
  await ws.setConfigs([{ text: flatConfig, dir: '/repo' }]);
  const built = [];
  const hold = ws.cache.hold;
  ws.cache.hold = (id, data, flags) => {
    built.push(id);
    return hold(id, data, flags);
  };
  await ws.warm(warmPaths);
  await ws.whenAnalyzed(`file://${activeFile}`);
  assert.deepEqual(built.slice(0, 4), [warmPaths[0], warmPaths[1], warmPaths[2], activeFile]);
  assert.deepEqual(reads.slice(0, 3), warmPaths.slice(0, 3));
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
  for (let index = 0; index < 9; index += 1) await ws.warm([`/repo/other-${index}/mock.yml`]);
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
  return configText(resourcesEntry({ function: markerFunction({ definitions }) }, 'first_word'));
}

const functionsSchema = JSON.stringify({
  ...JSON.parse(schema),
  'x-yaml-dsl-functions': { ssm: [{ name: 'parameter', type: 'text', required: true, repeated: false }] },
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
  answer({ function_signatures: { upper: { parameters: [{ name: 'str', type: 'string' }] } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loaded, ['terraform']);
  await ws.whenAnalyzed(`file://${common}`);
  assert.deepEqual(messages(), ['unknown function nope', 'a call result is not allowed as placeholder_in_text']);
  assert.equal(ws.hover(`file://${common}`, at(text, 'ssm')).contents.value, 'ssm(parameter: text)');
  assert.equal(ws.hover(`file://${common}`, at(text, 'nope')).contents.value, 'nope');
  const callTokens = ws.semanticTokens(`file://${common}`)
    .filter((token) => token.line === 1)
    .map((token) => [token.character, token.length, token.type]);
  assert.deepEqual(callTokens, [[5, 3, 'keyword'], [8, 3, 'function']]);
  const typing = text.replace('  bad fn.nope: x', '  e fn.u: x');
  await ws.sync(`file://${common}`, common, typing);
  const offered = ws.completion(`file://${common}`, { line: 3, character: 8 });
  assert.deepEqual(offered.map((item) => [item.label, item.kind, item.detail]), [
    ['fn.upper', 'function', 'upper(str: text)'],
    ['fn.ssm', 'function', 'ssm(parameter: text)'],
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

test('a changed config reaches every resident stack, and drops the stacks it no longer claims', async () => {
  const otherCommon = '/repo/other-stack/mock.yml';
  const files = { [common]: 'locals:\n  db: x\n', [one]: 'a: 1\n', [otherCommon]: 'b: 1\n' };
  const ws = workspace(files);
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync(`file://${one}`, one, files[one]);
  await ws.warm([otherCommon]);
  ws.close(`file://${one}`);
  ws.takeEvicted();
  const narrowed = configText(resourcesEntry({ file_includes: ['**/mock-stack/**/mock.yml'] }));
  await ws.setConfigs([{ text: narrowed, dir: '/repo' }]);
  assert.deepEqual(ws.cache.get(common).data.dsl.fileIncludes, ['**/mock-stack/**/mock.yml']);
  assert.equal(ws.cache.get(otherCommon), null);
  assert.deepEqual(ws.takeEvicted(), [otherCommon]);
});

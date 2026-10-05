const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace, SCHEMA_UNAVAILABLE } = require('../lib/workspace');

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

const config = `
dsls:
  - id: resources
    match: ["**/mock.yml"]
    schema: https://example.test/fallback.json
    layers:
      environments: [one, two, three, four]
    symbols:
      - kind: local
        at: "$.locals.*"
        name: { from: key }
      - kind: resource
        at: "$.*.*"
        skip: [schema_version, cloud, env, locals, outputs, sync]
        exclude: [defaults]
        name: { token: last, spelling: snake }
        qualify: { type: parent }
    references:
      - pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)'
        where: whole
        target: { kind: resource, type: type, name: name }
      - pattern: '^local\\.(?<name>[a-z0-9_]+)$'
        where: whole
        target: { kind: local, name: name }
      - pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}'
        where: within
        target: { kind: local, name: name }
`;

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

test('hover, definition, and folds use the whole stack', async () => {
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
  assert.match(sourceHover.contents.value, /mocktype\.primary — .*mock\.yml/);
  assert.match(sourceHover.contents.value, /primary:/);
  const sourceDef = ws.definition(oneUri, at(files[one], 'ref mocktype.primary'));
  assert.equal(sourceDef.path, common);

  await ws.sync('file://' + common, common, files[common]);
  const localHover = ws.hover('file://' + common, at(files[common], 'local.db'));
  assert.equal(localHover.contents.value, 'mock-value');
  assert.equal(ws.definition('file://' + common, at(files[common], 'local.db')).path, common);
  const field = ws.hover('file://' + common, at(files[common], 'label'));
  assert.equal(field.contents.value, '[optional] Mock label.');

  const within = ws.hover(oneUri, at(files[one], 'local.db'));
  assert.match(within.contents.value, /^mock-value/);
  assert.match(within.contents.value, /db:/);

  assert.deepEqual(ws.foldsFor(one), { stackId: common, environments: ['one'] });
  assert.deepEqual(ws.foldsFor(common).environments, ['one', 'two', 'three', 'four']);
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
  const shared = ws.definition('file://' + two, at(files[two], 'ref mocktype.shared'));
  assert.equal(shared.path, four);
  const unresolved = ws.hover('file://' + two, at(files[two], 'ref mocktype.primary'));
  assert.match(unresolved.contents.value, /mocktype\.primary — /);
  assert.equal(ws.definition('file://' + two, at(files[two], 'ref mocktype.nope')), null);
  await ws.sync(foldUri, foldUri, 'name: overwritten\n');
  assert.equal(ws.hover('file://' + common, at(files[common], 'local.db')).contents.value, 'mock-value');

  assert.equal(ws.hover('file://missing', { line: 0, character: 0 }), null);
  assert.equal(ws.definition('yaml-dsl-fold:nope', { line: 0, character: 0 }), null);
  assert.equal(ws.foldText('/missing', 'one'), '');
  assert.deepEqual(ws.foldsFor('/missing'), { stackId: null, environments: [] });
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
  const relative = `
dsls:
  - id: resources
    match: ["**/mock.yml"]
    schema: schema.json
    symbols: []
    references: []
`;
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync('file:///repo/only/mock.yml', '/repo/only/mock.yml', files['/repo/only/mock.yml']);
  const diags = ws.diagnostics('file:///repo/only/mock.yml');
  assert.equal(diags.some((item) => item.message === 'schema is unavailable'), false);
  await ws.sync('file:///repo/good/mock.yml', '/repo/good/mock.yml', files['/repo/good/mock.yml']);
  assert.equal(ws.diagnostics('file:///repo/good/mock.yml').some((item) => item.message === 'schema is unavailable'), false);

  await ws.setConfigs([{ text: 'dsls: [', dir: '/repo' }]);
  await ws.sync('file:///repo/yaml-dsl.yml', '/repo/yaml-dsl.yml', 'dsls: [');
  assert.ok(ws.diagnostics('file:///repo/yaml-dsl.yml')[0].message.length > 0);

  const open = 'name: from-editor\n';
  await ws.setConfigs([{ text: relative, dir: '/repo/disk' }]);
  await ws.sync('file:///repo/disk/mock.yml', '/repo/disk/mock.yml', open);
  files['/repo/disk/schema.json'] = JSON.stringify({ properties: { name: { description: 'the name' } } });
  await ws.sync('file:///repo/disk/mock.yml', '/repo/disk/mock.yml', open);
  const field = ws.hover('file:///repo/disk/mock.yml', at(open, 'name'));
  assert.equal(field.contents.value, 'the name');
  const boom = workspace({}, async () => schema, async () => { throw new Error('boom'); });
  await boom.setConfigs([{ text: config, dir: '/repo' }]);
  await boom.sync('file:///repo/boom/mock.yml', '/repo/boom/mock.yml', '# yaml-language-server: $schema=missing.json\nname: plain\n');
  assert.equal(boom.diagnostics('file:///repo/boom/mock.yml').some((item) => item.message === 'schema is unavailable'), false);
});

test('two DSLs, a parse error, and a DSL without layers', async () => {
  const both = `
dsls:
  - id: a
    match: ["**/mock.yml"]
  - id: b
    match: ["**/mock.yml"]
  - id: note
    match: ["**/note.yml"]
    symbols:
      - kind: local
        at: "$.locals.*"
    references:
      - pattern: '^local\\.(?<name>[a-z0-9_]+)$'
        where: whole
        target: { kind: local, name: name }
`;
  const ws = workspace({}, async () => null);
  await ws.setConfigs([{ text: both, dir: '/repo' }]);
  await ws.sync('file:///repo/mock.yml', '/repo/mock.yml', 'name: a\n');
  assert.match(ws.diagnostics('file:///repo/mock.yml')[0].message, /claimed by a and b/);
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals:\n  db: mock-value\nuse: local.db\n');
  const hover = ws.hover('file:///repo/note.yml', at('locals:\n  db: mock-value\nuse: local.db\n', 'local.db'));
  assert.equal(hover.contents.value, 'mock-value');
  assert.deepEqual(ws.foldsFor('/repo/note.yml'), { stackId: null, environments: [] });
  assert.equal(ws.foldText('/repo/note.yml', 'one'), '');
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals: [\n');
  assert.ok(ws.diagnostics('file:///repo/note.yml').length > 0);
  await ws.setActive(null);
  await ws.setActive('/repo/missing.yml');
  ws.setVisibleFolds(['/repo/note.yml']);
  assert.equal(ws.hover('yaml-dsl-fold:%2Frepo%2Fmissing/one', { line: 0, character: 0 }), null);
  ws.close('file:///repo/note.yml');
  assert.deepEqual(ws.diagnostics('file:///repo/note.yml'), []);
});

test('loading past the pin capacity evicts the oldest unpinned stack', async () => {
  const plain = `
dsls:
  - id: resources
    match: ["**/mock.yml"]
    layers:
      environments: [one]
`;
  const ws = workspace({}, async () => null);
  await ws.setConfigs([{ text: plain, dir: '/repo' }]);
  for (let i = 0; i < 10; i += 1) {
    const file = `/repo/s${i}/mock.yml`;
    await ws.setActive(file);
    await ws.sync('file://' + file, file, 'name: a\n');
  }
  ws.setVisibleFolds(['/repo/s1/mock.yml']);
  assert.equal(ws.cache.get('/repo/s0/mock.yml'), null);
  assert.ok(ws.cache.get('/repo/s1/mock.yml'));
  assert.ok(ws.takeEvicted().length >= 0);
});

test('a missing modeline walks the schema search path from the file', async () => {
  const found = '/repo/mock-app/one/.schema/sample.schema.json';
  const files = {
    [found]: JSON.stringify({ properties: { name: { description: 'from the side stack' } } }),
  };
  const ws = workspace(files, async () => null);
  await ws.setConfigs([{
    text: `
dsls:
  - id: resources
    match: ["**/mock.yml"]
    schema:
      - .schema/sample.schema.json
      - one/.schema/sample.schema.json
      - 1
`,
    dir: '/repo',
  }]);
  const common = '/repo/mock-app/mock.yml';
  const text = 'name: plain\n';
  await ws.sync('file://' + common, common, text);
  assert.ok(ws.reads.includes('/repo/mock-app/.schema/sample.schema.json'));
  assert.ok(ws.reads.includes(found));
  assert.equal(ws.hover('file://' + common, at(text, 'name')).contents.value, 'from the side stack');
  const env = '/repo/mock-app/one/mock.yml';
  await ws.sync('file://' + env, env, text);
  assert.equal(ws.hover('file://' + env, at(text, 'name')).contents.value, 'from the side stack');
  const named = '# yaml-language-server: $schema=missing.json\n' + text;
  await ws.sync('file://' + common, common, named);
  assert.equal(ws.hover('file://' + common, at(named, 'name')).contents.value, 'from the side stack');
  const bare = '/repo/bare/mock.yml';
  const bareText = 'name: plain\n';
  await ws.setConfigs([{ text: 'dsls:\n  - id: sample\n    match: ["**/mock.yml"]\n', dir: '/repo' }]);
  await ws.sync('file://' + bare, bare, bareText);
  assert.ok(ws.diagnostics('file://' + bare).some((item) => item.message === 'schema is unavailable'));
  assert.equal(ws.hover('file://' + bare, at(bareText, 'name')), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace, SCHEMA_UNAVAILABLE } = require('../lib/workspace');

const schema = JSON.stringify({
  description: 'root',
  properties: {
    redshift: { $ref: '#/definitions/redshift_map', description: '[optional] Redshift clusters.' },
  },
  definitions: {
    string_or_ref: { description: 'a literal string, a ref, or a bare local' },
    redshift_map: { patternProperties: { '^(?!defaults$).+$': { $ref: '#/definitions/redshift' } } },
    redshift: { properties: { database_name: { $ref: '#/definitions/string_or_ref', description: '[optional] Database name.' }, source: { description: 'source' } } },
  },
});

const config = `
dsls:
  - id: resources
    match: ["**/resources.yml"]
    schema: https://example.test/fallback.json
    layers:
      environments: [dev, staging, uat, production]
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

const root = '/repo/rds/datahub';
const common = `${root}/resources.yml`;
const dev = `${root}/dev/resources.yml`;
const staging = `${root}/staging/resources.yml`;
const uat = `${root}/uat/resources.yml`;
const production = `${root}/production/resources.yml`;

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
    [common]: '# yaml-language-server: $schema=schema.json\nlocals:\n  db: warehouse\nredshift:\n  primary:\n    database_name: local.db\n',
    [dev]: '# yaml-language-server: $schema=../schema.json\nredshift:\n  replica:\n    source: ref redshift.primary\n    database_name: "pre ${local.db}"\n',
    [staging]: '# yaml-language-server: $schema=../schema.json\nredshift:\n  replica:\n    source: ref redshift.primary\n    source2: ref redshift.shared\n',
    [uat]: '# yaml-language-server: $schema=../schema.json\nredshift:\n  shared: {}\n',
    [production]: '# yaml-language-server: $schema=../schema.json\nredshift:\n  shared: {}\n',
  };
  const fetched = [];
  const ws = workspace(files, async (url) => {
    fetched.push(url);
    return null;
  });
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync('file://' + dev, dev, files[dev]);
  const before = ws.reads.length;
  await ws.setActive(common);
  assert.equal(ws.reads.length, before);
  assert.equal(fetched.length, 0);

  const devUri = 'file://' + dev;
  const sourceHover = ws.hover(devUri, at(files[dev], 'ref redshift.primary'));
  assert.match(sourceHover.contents.value, /redshift\.primary — .*resources\.yml$/);
  const sourceDef = ws.definition(devUri, at(files[dev], 'ref redshift.primary'));
  assert.equal(sourceDef.path, common);

  await ws.sync('file://' + common, common, files[common]);
  const localHover = ws.hover('file://' + common, at(files[common], 'local.db'));
  assert.equal(localHover.contents.value, 'warehouse');
  assert.equal(ws.definition('file://' + common, at(files[common], 'local.db')).path, common);
  const field = ws.hover('file://' + common, at(files[common], 'database_name'));
  assert.equal(field.contents.value, '[optional] Database name.');

  const within = ws.hover(devUri, at(files[dev], '${local.db}'));
  assert.equal(within.contents.value, 'warehouse');

  assert.deepEqual(ws.foldsFor(dev), { stackId: common, environments: ['dev'] });
  assert.deepEqual(ws.foldsFor(common).environments, ['dev', 'staging', 'uat', 'production']);
  const folded = ws.foldText(common, 'dev');
  assert.match(folded, /dev\/resources.yml/);
  assert.match(folded, /warehouse/);
  assert.match(ws.foldText(common, 'staging'), /the common layer|staging\/resources.yml/);
  const stagingFold = ws.foldText(common, 'staging');
  assert.match(stagingFold, /staging\/resources.yml/);

  const foldUri = `yaml-dsl-fold:${encodeURIComponent(common)}/dev`;
  const foldHover = ws.hover(foldUri, at(folded, 'database_name'));
  assert.equal(foldHover.contents.value, '[optional] Database name.');
  const foldDef = ws.definition(foldUri, at(folded, 'ref redshift.primary'));
  assert.equal(foldDef.path, common);

  await ws.sync('file://' + staging, staging, files[staging]);
  const shared = ws.definition('file://' + staging, at(files[staging], 'ref redshift.shared'));
  assert.equal(shared.path, production);
  const unresolved = ws.hover('file://' + staging, at(files[staging], 'ref redshift.primary'));
  assert.match(unresolved.contents.value, /redshift\.primary — /);

  assert.equal(ws.hover('file://missing', { line: 0, character: 0 }), null);
  assert.equal(ws.definition('yaml-dsl-fold:nope', { line: 0, character: 0 }), null);
  assert.equal(ws.foldText('/missing', 'dev'), '');
  assert.deepEqual(ws.foldsFor('/missing'), { stackId: null, environments: [] });
  assert.equal(SCHEMA_UNAVAILABLE, 'schema is unavailable');
});

test('a modeline that fails falls through to the published schema', async () => {
  const files = {
    '/repo/only/resources.yml': '# yaml-language-server: $schema=https://example.test/missing.json\nname: plain\n',
    '/repo/bad.json': '[',
    '/repo/good/resources.yml': '# yaml-language-server: $schema=../bad.json\nname: plain\n',
    '/repo/disk/resources.yml': 'name: from-disk\n',
  };
  const ws = workspace(files, async (url) => (url.endsWith('fallback.json') ? schema : null));
  const relative = `
dsls:
  - id: resources
    match: ["**/resources.yml"]
    schema: schema.json
    symbols: []
    references: []
`;
  await ws.setConfigs([{ text: config, dir: '/repo' }]);
  await ws.sync('file:///repo/only/resources.yml', '/repo/only/resources.yml', files['/repo/only/resources.yml']);
  const diags = ws.diagnostics('file:///repo/only/resources.yml');
  assert.equal(diags.some((item) => item.message === 'schema is unavailable'), false);
  await ws.sync('file:///repo/good/resources.yml', '/repo/good/resources.yml', files['/repo/good/resources.yml']);
  assert.equal(ws.diagnostics('file:///repo/good/resources.yml').some((item) => item.message === 'schema is unavailable'), false);

  await ws.setConfigs([{ text: 'dsls: [', dir: '/repo' }]);
  await ws.sync('file:///repo/yaml-dsl.yml', '/repo/yaml-dsl.yml', 'dsls: [');
  assert.ok(ws.diagnostics('file:///repo/yaml-dsl.yml')[0].message.length > 0);

  const open = 'name: from-editor\n';
  await ws.setConfigs([{ text: relative, dir: '/repo/disk' }]);
  await ws.sync('file:///repo/disk/resources.yml', '/repo/disk/resources.yml', open);
  files['/repo/disk/schema.json'] = JSON.stringify({ properties: { name: { description: 'the name' } } });
  await ws.sync('file:///repo/disk/resources.yml', '/repo/disk/resources.yml', open);
  const field = ws.hover('file:///repo/disk/resources.yml', at(open, 'name'));
  assert.equal(field.contents.value, 'the name');
  const boom = workspace({}, async () => schema, async () => { throw new Error('boom'); });
  await boom.setConfigs([{ text: config, dir: '/repo' }]);
  await boom.sync('file:///repo/boom/resources.yml', '/repo/boom/resources.yml', '# yaml-language-server: $schema=missing.json\nname: plain\n');
  assert.equal(boom.diagnostics('file:///repo/boom/resources.yml').some((item) => item.message === 'schema is unavailable'), false);
});

test('two DSLs, a parse error, and a DSL without layers', async () => {
  const both = `
dsls:
  - id: a
    match: ["**/resources.yml"]
  - id: b
    match: ["**/resources.yml"]
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
  await ws.sync('file:///repo/resources.yml', '/repo/resources.yml', 'name: a\n');
  assert.match(ws.diagnostics('file:///repo/resources.yml')[0].message, /claimed by a and b/);
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals:\n  db: warehouse\nuse: local.db\n');
  const hover = ws.hover('file:///repo/note.yml', at('locals:\n  db: warehouse\nuse: local.db\n', 'local.db'));
  assert.equal(hover.contents.value, 'warehouse');
  assert.deepEqual(ws.foldsFor('/repo/note.yml'), { stackId: null, environments: [] });
  assert.equal(ws.foldText('/repo/note.yml', 'dev'), '');
  await ws.sync('file:///repo/note.yml', '/repo/note.yml', 'locals: [\n');
  assert.ok(ws.diagnostics('file:///repo/note.yml').length > 0);
  await ws.setActive(null);
  await ws.setActive('/repo/missing.yml');
  ws.setVisibleFolds(['/repo/note.yml']);
  assert.equal(ws.hover('yaml-dsl-fold:%2Frepo%2Fmissing/dev', { line: 0, character: 0 }), null);
  ws.close('file:///repo/note.yml');
  assert.deepEqual(ws.diagnostics('file:///repo/note.yml'), []);
});

test('loading past the pin capacity evicts the oldest unpinned stack', async () => {
  const plain = `
dsls:
  - id: resources
    match: ["**/resources.yml"]
    layers:
      environments: [dev]
`;
  const ws = workspace({}, async () => null);
  await ws.setConfigs([{ text: plain, dir: '/repo' }]);
  for (let i = 0; i < 10; i += 1) {
    const file = `/repo/s${i}/resources.yml`;
    await ws.setActive(file);
    await ws.sync('file://' + file, file, 'name: a\n');
  }
  ws.setVisibleFolds(['/repo/s1/resources.yml']);
  assert.equal(ws.cache.get('/repo/s0/resources.yml'), null);
  assert.ok(ws.cache.get('/repo/s1/resources.yml'));
  assert.ok(ws.takeEvicted().length >= 0);
});

test('a missing modeline walks the schema search path from the file', async () => {
  const found = '/repo/firehose/dev/.terraform/modules/resources_yaml/resources.schema.json';
  const files = {
    [found]: JSON.stringify({ properties: { name: { description: 'from the dev stack' } } }),
  };
  const ws = workspace(files, async () => null);
  await ws.setConfigs([{
    text: `
dsls:
  - id: resources
    match: ["**/resources.yml"]
    schema:
      - .terraform/modules/resources_yaml/resources.schema.json
      - dev/.terraform/modules/resources_yaml/resources.schema.json
      - 1
`,
    dir: '/repo',
  }]);
  const common = '/repo/firehose/resources.yml';
  const text = 'name: plain\n';
  await ws.sync('file://' + common, common, text);
  assert.ok(ws.reads.includes('/repo/firehose/.terraform/modules/resources_yaml/resources.schema.json'));
  assert.ok(ws.reads.includes(found));
  assert.equal(ws.hover('file://' + common, at(text, 'name')).contents.value, 'from the dev stack');
  const env = '/repo/firehose/dev/resources.yml';
  await ws.sync('file://' + env, env, text);
  assert.equal(ws.hover('file://' + env, at(text, 'name')).contents.value, 'from the dev stack');
  const named = '# yaml-language-server: $schema=missing.json\n' + text;
  await ws.sync('file://' + common, common, named);
  assert.equal(ws.hover('file://' + common, at(named, 'name')).contents.value, 'from the dev stack');
});

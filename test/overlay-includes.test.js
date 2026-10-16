const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace } = require('../lib/workspace');
const { analyzeDocument } = require('../lib/analyze');
const { foldedValueOf } = require('../lib/overlay-includes');
const { scope, declaration, reference, dslEntry, configText, parsedDsl } = require('./config-builders');

const SNIPPET = '/repo/snippets/mock-wait.yaml';
const BUCKET = '/repo/mock-bucket.yaml';
const QUEUE = '/repo/mock-queue.yaml';
const SCHEMA = '/repo/schema.json';

const includeLayers = {
  common_layer_discovery: 'overlay_includes',
  overlay_includes: [{
    key_paths: ["$..['Fn::Transform']"],
    value_conditions: [{ key: 'Name', value: 'AWS::Include' }],
    location_path: '$.Parameters.Location',
    location_mappings: [{ local: '{config_root}/snippets/', remote: 's3://mock-bucket/snippets/' }],
  }],
  duplicate_check: { depth: 2, key_depths: {}, skip_keys: [] },
};

const alphabetical = (path) => ({ path, skip_keys: [], order: 'alphabetical', first_keys: [], last_keys: [] });

const includeEntry = dslEntry('included', {
  file_includes: ['**/*.yaml'],
  schema_search_paths: ['{config_root}/schema.json'],
  tag_keys: [{ tag: '!Ref', key: 'Ref' }],
  layers: includeLayers,
  key_sort_orders: [alphabetical('$'), alphabetical('$..*')],
  scopes: { LOGICAL_ID: scope() },
  declarations: [declaration('$.Resources.*', 'LOGICAL_ID')],
  references: [reference('^!Ref (?<name>[A-Za-z0-9]+)$', 'LOGICAL_ID')],
});

const schema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    Resources: {
      type: 'object',
      properties: { 'Fn::Transform': { type: 'object' } },
      additionalProperties: {
        type: 'object',
        required: ['Type'],
        properties: {
          Type: { type: 'string', description: 'The resource type.' },
          Properties: { type: 'object' },
        },
      },
    },
  },
});

function includeText(location) {
  return [
    '  Fn::Transform:',
    '    Name: AWS::Include',
    '    Parameters:',
    `      Location: ${location}`,
  ].join('\n');
}

const snippetText = 'MockWait:\n  Type: Mock::Wait\n  Properties:\n    Handle: !Ref MockHandle\n';
const bucketText = [
  'Resources:',
  '  MockHandle:',
  '    Type: Mock::Handle',
  includeText('s3://mock-bucket/snippets/mock-wait.yaml'),
  '  MockUser:',
  '    Type: Mock::User',
  '    Properties:',
  '      Waits: !Ref MockWait',
  '  MockShared:',
  '    Type: Mock::Shared',
  '',
].join('\n');
const queueText = [
  'Resources:',
  '  MockHandle:',
  '    Type: Mock::Handle',
  includeText('s3://mock-bucket/snippets/mock-wait.yaml'),
  '  MockShared:',
  '    Type: Mock::Shared',
  '',
].join('\n');

function fakeTimers() {
  const pending = new Set();
  return {
    setTimeout(callback) {
      const timer = { callback };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      pending.delete(timer);
    },
    fireAll() {
      const due = [...pending];
      pending.clear();
      for (const timer of due) timer.callback();
    },
  };
}

function at(text, needle, shift = 0) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(needle);
  const line = text.slice(0, index).split('\n').length - 1;
  return { line, character: index - text.lastIndexOf('\n', index - 1) - 1 + shift };
}

async function includeWorkspace(files, timers = fakeTimers()) {
  const ws = createWorkspace({
    readFile: async (filePath) => (Object.hasOwn(files, filePath) ? files[filePath] : null),
    fetchText: async () => null,
    timerFunctions: timers,
  });
  await ws.setConfigs([{ text: configText(includeEntry), dir: '/repo' }]);
  return ws;
}

const stackFiles = { [SNIPPET]: snippetText, [BUCKET]: bucketText, [QUEUE]: queueText, [SCHEMA]: schema };

test('an include names its common layer through location_mappings, at the map holding it, in a list too', () => {
  const dsl = { ...parsedDsl(includeEntry), dir: '/repo' };
  const listed = [
    'Resources:',
    '  Fn::Transform:',
    '    - Name: AWS::Include',
    '      Parameters:',
    '        Location: s3://mock-bucket/snippets/a.yaml',
    '    - Name: Mock::Other',
    '',
  ].join('\n');
  const [include, ...others] = analyzeDocument(listed, BUCKET, dsl).includes;
  assert.deepEqual(others, []);
  assert.deepEqual(include.keyPath, ['Resources', 'Fn::Transform']);
  assert.deepEqual(include.holdingPath, ['Resources']);
  assert.equal(include.commonLayerPath, '/repo/snippets/a.yaml');
  const unmapped = analyzeDocument(`Resources:\n${includeText('s3://other-bucket/a.yaml')}\n`, BUCKET, dsl).includes;
  assert.equal(unmapped[0].commonLayerPath, null);
  assert.equal(unmapped[0].location, 's3://other-bucket/a.yaml');
});

test('a fold puts the common layer\'s entries in place of the include, the overlay\'s own entries winning', () => {
  const includes = [{ keyPath: ['Resources', 'Fn::Transform'], holdingPath: ['Resources'], commonLayerPath: SNIPPET }];
  const overlay = { Resources: { Kept: { Type: 'own' }, 'Fn::Transform': { Name: 'AWS::Include' } } };
  const common = { Added: { Type: 'common' }, Kept: { Type: 'common', Extra: 1 } };
  assert.deepEqual(foldedValueOf(overlay, includes, () => common), {
    Resources: { Added: { Type: 'common' }, Kept: { Type: 'own', Extra: 1 } },
  });
  assert.deepEqual(foldedValueOf(overlay, includes, () => undefined), overlay);
});

test('a template resolves its common layer\'s names, validates its fold, and opens the common layer', async () => {
  const ws = await includeWorkspace(stackFiles);
  await ws.sync(`file://${BUCKET}`, BUCKET, bucketText);
  const uri = `file://${BUCKET}`;
  assert.deepEqual(ws.references(uri).map((ref) => ref.kind), ['external']);
  const target = ws.definition(uri, at(bucketText, '!Ref MockWait', 6));
  assert.equal(target.path, SNIPPET);
  assert.deepEqual(target.range.start, { line: 0, character: 0 });
  assert.deepEqual(ws.problems(uri), []);
  const locationLink = ws.links(uri).find((link) => link.target === `file://${SNIPPET}`);
  assert.deepEqual(locationLink.range.start, at(bucketText, 's3://mock-bucket/snippets/mock-wait.yaml'));
  const foldText = ws.foldText(SNIPPET, BUCKET);
  assert.match(foldText, /^# mock-bucket\.yaml — /);
  assert.match(foldText, /MockWait:\n {4}Type: Mock::Wait/);
  assert.doesNotMatch(foldText, /Fn::Transform/);
});

test('a common layer resolves in every overlay\'s fold at its merge point, a problem reported once', async () => {
  const brokenSnippet = 'MockWait:\n  Properties:\n    Handle: !Ref MockHandle\n';
  const ws = await includeWorkspace({ ...stackFiles, [SNIPPET]: brokenSnippet });
  await ws.sync(`file://${BUCKET}`, BUCKET, bucketText);
  await ws.sync(`file://${QUEUE}`, QUEUE, queueText);
  await ws.sync(`file://${SNIPPET}`, SNIPPET, brokenSnippet);
  const uri = `file://${SNIPPET}`;
  assert.deepEqual(ws.references(uri).map((ref) => ref.kind), ['external']);
  const problems = ws.problems(uri);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /Type/);
  assert.match(problems[0].message, /\(mock-bucket\.yaml, mock-queue\.yaml\)$/);
  assert.deepEqual(problems[0].range.start, { line: 0, character: 0 });
  assert.deepEqual(ws.foldsFor(SNIPPET).overlayLabels, ['mock-bucket.yaml', 'mock-queue.yaml']);
});

test('a hover in a common layer documents the field at its merge point in each overlay', async () => {
  const ws = await includeWorkspace(stackFiles);
  await ws.sync(`file://${BUCKET}`, BUCKET, bucketText);
  await ws.sync(`file://${SNIPPET}`, SNIPPET, snippetText);
  const hovered = ws.hover(`file://${SNIPPET}`, at(snippetText, 'Type', 1));
  assert.match(hovered.contents.value, /The resource type\./);
});

test('a common layer read before any overlay naming it is read alone, as a file of its own', async () => {
  const ws = await includeWorkspace(stackFiles);
  await ws.sync(`file://${SNIPPET}`, SNIPPET, snippetText);
  assert.deepEqual(ws.references(`file://${SNIPPET}`).map((ref) => ref.kind), ['error']);
  assert.deepEqual(ws.foldsFor(SNIPPET), { stackId: null, overlayNames: [], overlayLabels: [] });
});

test('an unmapped location declares every name and is an info problem; a common layer\'s include is not followed', async () => {
  const unmappedText = [
    'Resources:',
    includeText('s3://other-bucket/a.yaml'),
    '  MockUser:',
    '    Type: Mock::User',
    '    Properties:',
    '      Waits: !Ref Anything',
    '',
  ].join('\n');
  const nestedInclude = includeText('s3://mock-bucket/snippets/other.yaml').replace(/^ {2}Fn::/, 'Fn::');
  const nestedSnippet = `${snippetText}${nestedInclude}\n`;
  const ws = await includeWorkspace({ ...stackFiles, [BUCKET]: unmappedText, [SNIPPET]: nestedSnippet });
  await ws.sync(`file://${BUCKET}`, BUCKET, unmappedText);
  const unmapped = ws.problems(`file://${BUCKET}`);
  assert.deepEqual(unmapped.map((problem) => [problem.severity, problem.message]), [
    ['info', 'no location mapping covers `s3://other-bucket/a.yaml`'],
  ]);
  assert.deepEqual(ws.references(`file://${BUCKET}`).map((ref) => ref.kind), ['local']);
  await ws.sync(`file://${QUEUE}`, QUEUE, queueText);
  await ws.sync(`file://${SNIPPET}`, SNIPPET, nestedSnippet);
  const nested = ws.problems(`file://${SNIPPET}`).filter((problem) => problem.severity === 'error');
  assert.deepEqual(nested.map((problem) => problem.message), ["a common layer's own include is not followed"]);
});

test('an entry every overlay holds beside the include moves into the common layer at its root', async () => {
  const timers = fakeTimers();
  const ws = await includeWorkspace(stackFiles, timers);
  await ws.sync(`file://${BUCKET}`, BUCKET, bucketText);
  await ws.sync(`file://${QUEUE}`, QUEUE, queueText);
  await ws.queueSuggestions(SNIPPET);
  const marks = ws.suggestionMarks(SNIPPET).files.flatMap((file) => file.marks);
  const sharedMove = marks.find((mark) => mark.suggestion.kind === 'move'
    && mark.suggestion.path.join('.') === 'Resources.MockShared');
  assert.ok(sharedMove, JSON.stringify(marks.map((mark) => [mark.suggestion.kind, mark.suggestion.path])));
  const applied = await ws.applySuggestion(SNIPPET, sharedMove.suggestion.id);
  const snippetEdit = applied.edit.documentChanges
    .find((change) => change.textDocument && change.textDocument.uri === `file://${SNIPPET}`);
  assert.match(snippetEdit.edits.map((edit) => edit.newText).join(''), /^MockShared:\n {2}Type: Mock::Shared/m);
});

test('an overlay that drops its include leaves the common layer\'s stack and is read alone', async () => {
  const files = { ...stackFiles };
  const ws = await includeWorkspace(files);
  await ws.sync(`file://${BUCKET}`, BUCKET, bucketText);
  const bucketFolds = { stackId: SNIPPET, overlayNames: [BUCKET], overlayLabels: ['mock-bucket.yaml'] };
  assert.deepEqual(ws.foldsFor(BUCKET), bucketFolds);
  const withoutInclude = 'Resources:\n  MockHandle:\n    Type: Mock::Handle\n';
  files[BUCKET] = withoutInclude;
  await ws.sync(`file://${BUCKET}`, BUCKET, withoutInclude);
  assert.deepEqual(ws.foldsFor(BUCKET), { stackId: null, overlayNames: [], overlayLabels: [] });
  assert.deepEqual(ws.problems(`file://${BUCKET}`), []);
});

test('a template with two includes takes both common layers, and is an overlay in each of their stacks', async () => {
  const otherSnippet = '/repo/snippets/mock-other.yaml';
  const bothText = `Outputs:\n${includeText('s3://mock-bucket/snippets/mock-other.yaml')}\n${bucketText}`;
  const files = { ...stackFiles, [BUCKET]: bothText, [otherSnippet]: 'MockOutput:\n  Value: !Ref MockWait\n' };
  const ws = await includeWorkspace(files);
  await ws.sync(`file://${BUCKET}`, BUCKET, bothText);
  assert.equal(ws.foldsFor(BUCKET).stackId, otherSnippet);
  assert.deepEqual(ws.references(`file://${BUCKET}`).map((ref) => ref.kind), ['external']);
  const foldText = ws.foldText(otherSnippet, BUCKET);
  assert.match(foldText, /Outputs:\n {2}MockOutput:/);
  assert.match(foldText, /MockWait:\n {4}Type: Mock::Wait/);
  await ws.sync(`file://${otherSnippet}`, otherSnippet, files[otherSnippet]);
  assert.deepEqual(ws.references(`file://${otherSnippet}`).map((ref) => ref.kind), ['external']);
  await ws.sync(`file://${SNIPPET}`, SNIPPET, snippetText);
  const snippetFolds = { stackId: SNIPPET, overlayNames: [BUCKET], overlayLabels: ['mock-bucket.yaml'] };
  assert.deepEqual(ws.foldsFor(SNIPPET), snippetFolds);
});

test('Enter on an overlay key the common layer already fills fills nothing it holds', async () => {
  const typed = bucketText.replace('  MockShared:\n    Type: Mock::Shared\n', '  MockWait:\n');
  const ws = await includeWorkspace({ ...stackFiles, [BUCKET]: typed });
  await ws.sync(`file://${BUCKET}`, BUCKET, typed);
  const keyLine = at(typed, '  MockWait:').line;
  assert.equal(ws.requiredFieldsAt(`file://${BUCKET}`, keyLine), null);
  const fresh = bucketText.replace('  MockShared:\n    Type: Mock::Shared\n', '  MockFresh:\n');
  await ws.sync(`file://${BUCKET}`, BUCKET, fresh);
  const filled = ws.requiredFieldsAt(`file://${BUCKET}`, at(fresh, '  MockFresh:').line);
  assert.deepEqual(filled.fields.map((field) => field.key), ['Type']);
});

test('completion in a common layer offers the schema\'s fields at its merge point', async () => {
  const typed = `${snippetText}MockNew:\n  Pro`;
  const ws = await includeWorkspace({ ...stackFiles, [SNIPPET]: typed });
  await ws.sync(`file://${BUCKET}`, BUCKET, bucketText);
  await ws.sync(`file://${SNIPPET}`, SNIPPET, typed);
  const labels = ws.completion(`file://${SNIPPET}`, at(typed, '  Pro', 5)).map((item) => item.label);
  assert.deepEqual(labels.sort(), ['Properties', 'Type']);
});

test('a modeline\'s fragment marks a fragment, validated at the node it names with no key required', async () => {
  const alonePath = '/repo/snippets/mock-alone.yaml';
  const aloneText = [
    '# yaml-language-server: $schema=../schema.json#/properties/Resources',
    'MockAlone:',
    '  Properties: {}',
    'MockBroken:',
    '  Type: 1',
    '',
  ].join('\n');
  const rootPath = '/repo/snippets/mock-root.yaml';
  const rootText = '# yaml-language-server: $schema=../schema.json#\nResources:\n  MockAlone:\n    Properties: {}\n';
  const fullText = rootText.replace('schema.json#', 'schema.json');
  const fullPath = '/repo/snippets/mock-full.yaml';
  const ws = await includeWorkspace({
    ...stackFiles,
    [alonePath]: aloneText,
    [rootPath]: rootText,
    [fullPath]: fullText,
  });
  for (const [filePath, text] of [[alonePath, aloneText], [rootPath, rootText], [fullPath, fullText]]) {
    await ws.sync(`file://${filePath}`, filePath, text);
  }
  assert.deepEqual(ws.problems(`file://${alonePath}`).map((problem) => problem.message), ['`Type` must be string']);
  const struck = (text) => [...text].map((character) => `${character}̶`).join('');
  const typeHover = ws.hover(`file://${alonePath}`, at(aloneText, 'Type', 1)).contents.value;
  assert.equal(typeHover, `\`\`\`\nType: string    ${struck('[required]')}\n\`\`\`\n\nThe resource type.`);
  const propertiesHover = ws.hover(`file://${alonePath}`, at(aloneText, 'Properties', 1)).contents.value;
  assert.match(propertiesHover, new RegExp(struck('[optional]').replace(/[[\]]/g, '\\$&')));
  const fullHover = ws.hover(`file://${fullPath}`, at(fullText, 'Properties', 1)).contents.value;
  assert.match(fullHover, /\[optional\]/);
  const schemaLink = ws.links(`file://${alonePath}`).find((link) => link.target === `file://${SCHEMA}`);
  assert.ok(schemaLink);
  assert.deepEqual(ws.problems(`file://${rootPath}`), []);
  assert.deepEqual(ws.problems(`file://${fullPath}`).map((problem) => problem.message), ['`Type` is required']);
});

test('an overlay shows its file name, its folder too where names clash, kept if labels still clash', async () => {
  const devQueue = '/repo/dev/mock-queue.yaml';
  const prodQueue = '/repo/prod/mock-queue.yaml';
  const nestedDevQueue = '/repo/nested/dev/mock-queue.yaml';
  const overlayPaths = [BUCKET, devQueue, prodQueue, nestedDevQueue];
  const ws = await includeWorkspace({
    ...stackFiles,
    [devQueue]: queueText,
    [prodQueue]: queueText,
    [nestedDevQueue]: queueText,
  });
  for (const filePath of overlayPaths) {
    await ws.sync(`file://${filePath}`, filePath, stackFiles[filePath] || queueText);
  }
  await ws.sync(`file://${SNIPPET}`, SNIPPET, snippetText);
  const folds = ws.foldsFor(SNIPPET);
  assert.deepEqual(folds.overlayNames, [devQueue, BUCKET, nestedDevQueue, prodQueue]);
  assert.deepEqual(folds.overlayLabels, [
    'dev/mock-queue.yaml',
    'mock-bucket.yaml',
    'dev/mock-queue.yaml',
    'prod/mock-queue.yaml',
  ]);
});

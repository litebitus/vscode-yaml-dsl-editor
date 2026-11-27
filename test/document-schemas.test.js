const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');
const { schemaResolution } = require('yaml-dsl-spec');
const { createDocumentSchemas } = require('../lib/document-schemas');
const { mockSchemaServer } = require('./mock-schema-server');

const MOCK_SCHEMA_TEXT = JSON.stringify({ properties: { size: { type: 'integer' } } });
const MACHINE_CREDENTIALS_HELP = "add `yaml_dsl_machine_credentials=true` to read it with the machine's credentials";
const MOCK_BUCKET = 'mock-schemas-bucket';
const MOCK_ROLE = 'arn:aws:iam::000000000000:role/mock-reader';
const SEEDED_OBJECTS = { 'public.schema.json': 'public-read', 'private.schema.json': undefined };
const schemaServer = mockSchemaServer();
let mockRoot = null;
let documentPath = null;

test.before(() => schemaServer.start());
test.after(() => schemaServer.stop());
test.beforeEach(() => {
  mockRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-dsl-editor-document-schemas-')));
  documentPath = path.join(mockRoot, 'mock-stack', 'mock.yml');
  schemaServer.requests.length = 0;
});
test.afterEach(() => {
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

function writtenFile(relativePath, text) {
  const filePath = path.join(mockRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  return filePath;
}

function modelineOf(location) {
  return `# yaml-language-server: $schema=${location}\nsize: 1\n`;
}

function motoClient() {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const localEndpoint = /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/;
  assert.match(String(endpoint), localEndpoint, 'S3 is read from a local Moto server');
  return new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true });
}

test('a modeline path is read from the file\'s folder with its fragment, and a {config_root} search path '
  + 'from the config folder', async () => {
  const besideStack = writtenFile('mock.schema.json', MOCK_SCHEMA_TEXT);
  const inConfigFolder = writtenFile('schemas/mock.schema.json', MOCK_SCHEMA_TEXT);
  const documentSchemas = createDocumentSchemas({ urlReaders: [] });
  const named = await documentSchemas.documentSchemaOf(
    documentPath,
    modelineOf('../mock.schema.json#/definitions/mock'),
    [],
    mockRoot,
  );
  assert.deepEqual(named, {
    schemaText: MOCK_SCHEMA_TEXT,
    schemaName: 'mock.schema.json',
    fragmentPointer: '/definitions/mock',
    watchedPaths: [besideStack],
    error: null,
  });
  const searched = await documentSchemas.documentSchemaOf(
    documentPath,
    'size: 1\n',
    ['{config_root}/schemas/mock.schema.json'],
    mockRoot,
  );
  assert.deepEqual(
    [searched.schemaText, searched.fragmentPointer, searched.watchedPaths],
    [MOCK_SCHEMA_TEXT, null, [inConfigFolder]],
  );
});

test('a missing source moves the search on, a pattern takes its first match in path order, '
  + 'and an unmatched pattern is watched from the folder above its first pattern step', async () => {
  writtenFile('mock-stack/.schema/b/mock.schema.json', '{"title":"b"}');
  const firstMatch = writtenFile('mock-stack/.schema/a/mock.schema.json', '{"title":"a"}');
  const documentSchemas = createDocumentSchemas({ urlReaders: [] });
  const found = await documentSchemas.documentSchemaOf(
    documentPath,
    modelineOf('missing.json'),
    ['.schema/*/mock.schema.json'],
    mockRoot,
  );
  assert.equal(found.schemaText, '{"title":"a"}');
  assert.deepEqual(found.watchedPaths, [path.join(mockRoot, 'mock-stack', 'missing.json'), firstMatch]);
  const unmatched = await documentSchemas.documentSchemaOf(
    documentPath,
    'size: 1\n',
    ['.absent/*/mock.schema.json'],
    mockRoot,
  );
  assert.deepEqual(unmatched.watchedPaths, [path.join(mockRoot, 'mock-stack', '.absent')]);
  assert.equal(unmatched.error, 'no schema found\n\n`.absent/*/mock.schema.json`: no file matches');
});

test('every source missing is one problem naming each candidate, and the problem is logged', async () => {
  const logged = [];
  const documentSchemas = createDocumentSchemas({ urlReaders: [], logInfo: (line) => logged.push(line) });
  const absentUrl = schemaServer.urlOf('/absent.json');
  const found = await documentSchemas.documentSchemaOf(documentPath, modelineOf('missing.json'), [absentUrl], mockRoot);
  const expected = `no schema found\n\n\`missing.json\`: no file is there\n\`${absentUrl}\`: the server answered 404`;
  assert.deepEqual([found.schemaText, found.error], [null, expected]);
  assert.deepEqual(logged, [`schema of ${documentPath}: ${expected}`]);
});

test('a URL with a max age is read once into the storage folder\'s kept copies, which serve the next reads, '
  + 'and a parameter the cache does not read is a problem', async () => {
  schemaServer.serve('/kept.json', { text: MOCK_SCHEMA_TEXT, entityTag: '"mock-kept"' });
  const storageFolder = path.join(mockRoot, 'mock-storage');
  const documentSchemas = createDocumentSchemas({ urlReaders: [] });
  documentSchemas.setStorageFolder(storageFolder);
  const keptText = modelineOf(schemaServer.urlOf('/kept.json?mock=1&yaml_dsl_max_age_days=7'));
  const first = await documentSchemas.documentSchemaOf(documentPath, keptText, [], mockRoot);
  const restarted = createDocumentSchemas({ urlReaders: [] });
  restarted.setStorageFolder(storageFolder);
  const second = await restarted.documentSchemaOf(documentPath, keptText, [], mockRoot);
  assert.deepEqual([first.schemaText, second.schemaText], [MOCK_SCHEMA_TEXT, MOCK_SCHEMA_TEXT]);
  assert.deepEqual(first.watchedPaths, []);
  assert.deepEqual(schemaServer.requests.map((request) => request.path), ['/kept.json?mock=1']);
  assert.equal(fs.readdirSync(path.join(storageFolder, 'schema-urls')).length, 1);
  const misspelled = modelineOf(schemaServer.urlOf('/kept.json?yaml_dsl_max_age=7'));
  const problem = await documentSchemas.documentSchemaOf(documentPath, misspelled, [], mockRoot);
  assert.equal(problem.error, '`yaml_dsl_max_age` is not a parameter of a schema URL');
});

test('without a storage folder a URL is read each time and no copy is kept', async () => {
  schemaServer.serve('/unkept.json', { text: MOCK_SCHEMA_TEXT });
  const documentSchemas = createDocumentSchemas({ urlReaders: [] });
  documentSchemas.setStorageFolder(null);
  const unkeptText = modelineOf(schemaServer.urlOf('/unkept.json?yaml_dsl_max_age_days=7'));
  await documentSchemas.documentSchemaOf(documentPath, unkeptText, [], mockRoot);
  await documentSchemas.documentSchemaOf(documentPath, unkeptText, [], mockRoot);
  assert.deepEqual(schemaServer.requests.map((request) => request.path), ['/unkept.json', '/unkept.json']);
});

test('a kept copy that cannot be saved is logged, and the schema is still read', async () => {
  schemaServer.serve('/unsaved.json', { text: MOCK_SCHEMA_TEXT });
  const storageThatIsAFile = writtenFile('mock-storage', 'mock');
  const logged = [];
  const documentSchemas = createDocumentSchemas({ urlReaders: [], logError: (line) => logged.push(line) });
  documentSchemas.setStorageFolder(storageThatIsAFile);
  const unsavedText = modelineOf(schemaServer.urlOf('/unsaved.json?yaml_dsl_max_age_days=7'));
  const found = await documentSchemas.documentSchemaOf(documentPath, unsavedText, [], mockRoot);
  assert.equal(found.schemaText, MOCK_SCHEMA_TEXT);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^failed to save schema store entry `.*schema-urls.*\.json`: /);
});

test('a URL whose read is refused, with no copy kept, ends the search with a problem saying how to opt in '
  + 'to the machine\'s credentials', async () => {
  schemaServer.serve('/private.json', { status: 401 });
  writtenFile('mock-stack/mock.schema.json', MOCK_SCHEMA_TEXT);
  const privateUrl = schemaServer.urlOf('/private.json');
  const documentSchemas = createDocumentSchemas({ urlReaders: [] });
  const refused = await documentSchemas.documentSchemaOf(
    documentPath,
    'size: 1\n',
    [privateUrl, 'mock.schema.json'],
    mockRoot,
  );
  assert.deepEqual(refused, {
    schemaText: null,
    schemaName: null,
    fragmentPointer: null,
    watchedPaths: [],
    error: `127.0.0.1 refused to read \`${privateUrl}\`\n\n401; ${MACHINE_CREDENTIALS_HELP}`,
  });
});

test('a registered reader reads the URLs of its prefix, asked again with the machine\'s credentials '
  + 'only where the URL opts in', async () => {
  const asked = [];
  const mockReader = {
    urlPrefixes: ['mock://'],
    readsRemoteSources: true,
    readSchemaUrl: async (request) => {
      asked.push([request.fetchUrl, request.machineCredentials]);
      if (request.machineCredentials) {
        return schemaResolution.answerOf({ outcomeKind: 'textSent', schemaText: MOCK_SCHEMA_TEXT, copyVersion: null });
      }
      return schemaResolution.refusedAnswer([
        { refusedBy: 'mock-host', credentialOrigin: null, refusalReason: '401', renewalFix: null },
      ]);
    },
  };
  const documentSchemas = createDocumentSchemas({ urlReaders: [mockReader] });
  const mockUrl = 'mock://mock-bucket/mock.json';
  const optedInUrl = `${mockUrl}?yaml_dsl_machine_credentials=true`;
  const found = await documentSchemas.documentSchemaOf(documentPath, modelineOf(optedInUrl), [], mockRoot);
  const unopted = await documentSchemas.documentSchemaOf(documentPath, modelineOf(mockUrl), [], mockRoot);
  assert.deepEqual([found.schemaText, found.schemaName], [MOCK_SCHEMA_TEXT, optedInUrl]);
  assert.equal(unopted.error, `mock-host refused to read \`${mockUrl}\`\n\n401; ${MACHINE_CREDENTIALS_HELP}`);
  assert.deepEqual(asked, [[mockUrl, false], [mockUrl, true], [mockUrl, false]]);
});

test.describe('a schema in an S3 bucket', () => {
  test.beforeEach(async () => {
    const client = motoClient();
    await client.send(new CreateBucketCommand({ Bucket: MOCK_BUCKET }));
    for (const [objectKey, objectAcl] of Object.entries(SEEDED_OBJECTS)) {
      await client.send(new PutObjectCommand({
        Bucket: MOCK_BUCKET,
        Key: objectKey,
        Body: MOCK_SCHEMA_TEXT,
        ACL: objectAcl,
      }));
    }
  });
  test.afterEach(async () => {
    const client = motoClient();
    for (const objectKey of Object.keys(SEEDED_OBJECTS)) {
      await client.send(new DeleteObjectCommand({ Bucket: MOCK_BUCKET, Key: objectKey }));
    }
    await client.send(new DeleteBucketCommand({ Bucket: MOCK_BUCKET }));
  });

  test('a public object is read without credentials, and a private one only where the URL opts in, '
    + 'as the machine or as the role it names', async () => {
    const documentSchemas = createDocumentSchemas();
    const schemaTextOf = async (location) => {
      const found = await documentSchemas.documentSchemaOf(documentPath, modelineOf(location), [], mockRoot);
      return found.schemaText;
    };
    const privateUrl = `s3://${MOCK_BUCKET}/private.schema.json`;
    assert.equal(await schemaTextOf(`s3://${MOCK_BUCKET}/public.schema.json`), MOCK_SCHEMA_TEXT);
    assert.equal(await schemaTextOf(`${privateUrl}?yaml_dsl_machine_credentials=true`), MOCK_SCHEMA_TEXT);
    const asRole = `${privateUrl}?assume_role=${MOCK_ROLE}&yaml_dsl_machine_credentials=true`;
    assert.equal(await schemaTextOf(asRole), MOCK_SCHEMA_TEXT);
    const refused = await documentSchemas.documentSchemaOf(documentPath, modelineOf(privateUrl), [], mockRoot);
    assert.equal(refused.schemaText, null);
    assert.match(refused.error, /^AWS refused to read `s3:\/\/mock-schemas-bucket\/private\.schema\.json`\n\n/);
    assert.ok(refused.error.endsWith(MACHINE_CREDENTIALS_HELP), refused.error);
  });

  test('an object the bucket lacks is missing, and the search moves on', async () => {
    writtenFile('mock-stack/mock.schema.json', '{"title":"mock"}');
    const documentSchemas = createDocumentSchemas();
    const absentUrl = `s3://${MOCK_BUCKET}/absent.schema.json?yaml_dsl_machine_credentials=true`;
    const found = await documentSchemas.documentSchemaOf(
      documentPath,
      modelineOf(absentUrl),
      ['mock.schema.json'],
      mockRoot,
    );
    assert.equal(found.schemaText, '{"title":"mock"}');
  });
});

test('past the store capacity the least recently used kept copy is dropped', async () => {
  schemaServer.serve('/first.json', { text: MOCK_SCHEMA_TEXT });
  schemaServer.serve('/second.json', { text: MOCK_SCHEMA_TEXT });
  const storageFolder = path.join(mockRoot, 'mock-storage');
  const keptCopiesFolder = path.join(storageFolder, 'schema-urls');
  const documentSchemas = createDocumentSchemas({ urlReaders: [] });
  documentSchemas.setStorageFolder(storageFolder);
  documentSchemas.setStoreCapacity(1);
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  const keptNames = () => fs.readdirSync(keptCopiesFolder);
  await documentSchemas.documentSchemaOf(documentPath, modelineOf(schemaServer.urlOf('/first.json')), [], mockRoot);
  const [firstCopy] = keptNames();
  fs.utimesSync(path.join(keptCopiesFolder, firstCopy), longAgo, longAgo);
  await documentSchemas.documentSchemaOf(documentPath, modelineOf(schemaServer.urlOf('/second.json')), [], mockRoot);
  assert.equal(keptNames().length, 1);
  assert.notEqual(keptNames()[0], firstCopy);
  documentSchemas.setStoreCapacity(2);
  await documentSchemas.documentSchemaOf(documentPath, modelineOf(schemaServer.urlOf('/first.json')), [], mockRoot);
  assert.equal(keptNames().length, 2);
});

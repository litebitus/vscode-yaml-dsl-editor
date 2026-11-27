const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  shownDocument,
  positionInText,
  hoverTextBecomes,
  schemaTextOf,
  paintedProblemMessagesBecome,
  extensionClient,
  extensionSettled,
} = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');
const { mockSchemaServer } = require('../mock-schema-server');

const SIZE_DOCUMENTATION = `\`size\`: *integer*\n\n${schemaTextOf('[optional] Mock size from a URL.')}`;

function stackFileWithModeline(folderLabel, schemaUrl) {
  const folder = path.join(vscode.workspace.workspaceFolders[1].uri.fsPath, `${folderLabel}-${vscode.version}`);
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, 'mock.yml');
  fs.writeFileSync(filePath, `# yaml-language-server: $schema=${schemaUrl}\nsize: 1\n`);
  return filePath;
}

suite('schema URL copies', () => {
  const schemaServer = mockSchemaServer();
  isolateEachTest();
  suiteSetup(() => schemaServer.start());
  suiteTeardown(() => schemaServer.stop());
  setup(() => {
    schemaServer.requests.length = 0;
    schemaServer.serve('/url-schema.json', {
      text: JSON.stringify({
        properties: { size: { type: 'integer', description: '[optional] Mock size from a URL.' } },
      }),
      entityTag: '"mock-url-schema"',
    });
    schemaServer.serve('/private-schema.json', { status: 401 });
  });

  test('a modeline URL with a max age is fetched once without the editor\'s parameter, and its copy serves the next '
    + 'file that names it', async () => {
    const schemaUrl = schemaServer.urlOf('/url-schema.json?mock=1&yaml_dsl_max_age_days=7');
    const first = (await shownDocument(stackFileWithModeline('url-schema-first', schemaUrl))).document;
    await hoverTextBecomes(first, positionInText(first, 'size', 1), SIZE_DOCUMENTATION);
    const second = (await shownDocument(stackFileWithModeline('url-schema-second', schemaUrl))).document;
    await hoverTextBecomes(second, positionInText(second, 'size', 1), SIZE_DOCUMENTATION);
    assert.deepEqual(schemaServer.requests.map((request) => request.path), ['/url-schema.json?mock=1']);
  });

  test('a modeline URL its server has nothing at leaves the file with no schema, '
    + 'the URL named as missing', async () => {
    const absentUrl = schemaServer.urlOf('/absent-schema.json');
    const doc = (await shownDocument(stackFileWithModeline('url-schema-absent', absentUrl))).document;
    await paintedProblemMessagesBecome(doc, [`no schema found\n\n\`${absentUrl}\`: the server answered 404`]);
  });

  test('a modeline URL whose server refuses the read is a problem naming the server and how to read it '
    + 'with the machine\'s credentials', async () => {
    const privateUrl = schemaServer.urlOf('/private-schema.json');
    const doc = (await shownDocument(stackFileWithModeline('url-schema-private', privateUrl))).document;
    await paintedProblemMessagesBecome(doc, [
      `127.0.0.1 refused to read \`${privateUrl}\`\n\n401; `
        + "add `yaml_dsl_machine_credentials=true` to read it with the machine's credentials",
    ]);
  });

  test('a modeline URL whose server refuses a later read loads its kept copy, the URL marked with an info problem '
    + 'naming the refusal', async () => {
    const revokedUrl = schemaServer.urlOf('/revoked-schema.json');
    schemaServer.serve('/revoked-schema.json', {
      text: JSON.stringify({
        properties: { size: { type: 'integer', description: '[optional] Mock size from a URL.' } },
      }),
    });
    const kept = (await shownDocument(stackFileWithModeline('url-schema-kept', revokedUrl))).document;
    await hoverTextBecomes(kept, positionInText(kept, 'size', 1), SIZE_DOCUMENTATION);
    schemaServer.serve('/revoked-schema.json', { status: 401 });
    const revoked = (await shownDocument(stackFileWithModeline('url-schema-revoked', revokedUrl))).document;
    await hoverTextBecomes(revoked, positionInText(revoked, 'size', 1), SIZE_DOCUMENTATION);
    await paintedProblemMessagesBecome(revoked, [
      `127.0.0.1 refused to read \`${revokedUrl}\`, so its kept copy was read\n\n401; `
        + "add `yaml_dsl_machine_credentials=true` to read it with the machine's credentials",
    ]);
    const answer = await (await extensionClient())
      .sendRequest('yaml-dsl/decorations', { uri: revoked.uri.toString() });
    const urlStart = revoked.lineAt(0).text.indexOf(revokedUrl);
    assert.deepEqual(
      answer.problems.map((problem) => [problem.severity, problem.range]),
      [['info', {
        start: { line: 0, character: urlStart },
        end: { line: 0, character: urlStart + revokedUrl.length },
      }]],
    );
  });
});

suite('schema store capacity', () => {
  const schemaServer = mockSchemaServer();
  const settings = () => vscode.workspace.getConfiguration('yaml-dsl-editor');
  const storedSchemaText = JSON.stringify({
    properties: { size: { type: 'integer', description: '[optional] Mock size from a URL.' } },
  });
  isolateEachTest();
  suiteSetup(() => schemaServer.start());
  suiteTeardown(() => schemaServer.stop());
  setup(async () => {
    schemaServer.requests.length = 0;
    schemaServer.serve('/store-first.json', { text: storedSchemaText });
    schemaServer.serve('/store-second.json', { text: storedSchemaText });
    await settings().update('cache.schemaStoreCapacity', 1, vscode.ConfigurationTarget.Global);
    await extensionSettled();
  });
  teardown(async () => {
    await settings().update('cache.schemaStoreCapacity', undefined, vscode.ConfigurationTarget.Global);
    await extensionSettled();
  });

  test('a schema URL whose kept copy the setting\'s capacity dropped is fetched again', async () => {
    const urlOf = (name) => schemaServer.urlOf(`/${name}.json?yaml_dsl_max_age_days=7`);
    const opened = [
      ['store-capacity-first', 'store-first'],
      ['store-capacity-second', 'store-second'],
      ['store-capacity-again', 'store-first'],
    ];
    for (const [folderLabel, schemaName] of opened) {
      const doc = (await shownDocument(stackFileWithModeline(folderLabel, urlOf(schemaName)))).document;
      await hoverTextBecomes(doc, positionInText(doc, 'size', 1), SIZE_DOCUMENTATION);
    }
    assert.deepEqual(
      schemaServer.requests.map((request) => request.path),
      ['/store-first.json', '/store-second.json', '/store-first.json'],
    );
  });
});

suite('schemas in S3', () => {
  const bucketName = 'mock-integration-bucket';
  const objectKey = 'mock.schema.json';
  const motoClient = () => new S3Client({
    region: 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL,
    forcePathStyle: true,
  });
  isolateEachTest();
  setup(async () => {
    assert.match(String(process.env.AWS_ENDPOINT_URL), /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/);
    await motoClient().send(new CreateBucketCommand({ Bucket: bucketName }));
    await motoClient().send(new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: JSON.stringify({
        properties: { size: { type: 'integer', description: '[optional] Mock size from a URL.' } },
      }),
      ACL: 'public-read',
    }));
  });
  teardown(async () => {
    await motoClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
    await motoClient().send(new DeleteBucketCommand({ Bucket: bucketName }));
  });

  test('a modeline S3 URL of a public object documents the file\'s fields', async () => {
    const schemaUrl = `s3://${bucketName}/${objectKey}`;
    const doc = (await shownDocument(stackFileWithModeline('s3-schema-public', schemaUrl))).document;
    await hoverTextBecomes(doc, positionInText(doc, 'size', 1), SIZE_DOCUMENTATION);
  });
});

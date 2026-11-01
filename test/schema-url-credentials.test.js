const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createSchemaUrlCopies } = require('../lib/schema-url-copies');
const { fetchResponseOrNull, fetchTextOrNull } = require('../lib/io');

const SCHEMA = '{"type": "object"}';
const GOOD_TOKEN = 'Bearer mock-good-token';
const RELEASE_LINK = 'https://github.com/mock-org/mock-repo/releases/download/mock/v1.0/mock.schema.json';

function serverOn(handle) {
  const server = http.createServer(handle);
  return {
    server,
    start: () => new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); }),
    stop: () => new Promise((resolve) => { server.close(resolve); }),
    url: () => `http://127.0.0.1:${server.address().port}`,
  };
}

const storage = serverOn((request, response) => {
  response.writeHead(request.headers.authorization ? 400 : 200);
  response.end(request.headers.authorization ? undefined : SCHEMA);
});

const github = serverOn((request, response) => {
  const letIn = request.headers.authorization === GOOD_TOKEN;
  if (letIn && request.url === '/repos/mock-org/mock-repo/releases/tags/mock%2Fv1.0') {
    response.writeHead(200);
    response.end(JSON.stringify({ assets: [{ name: 'mock.schema.json', url: `${github.url()}/assets/7` }] }));
  } else if (letIn && request.url === '/assets/7') {
    response.writeHead(302, { Location: `${storage.url()}/stored/7` });
    response.end();
  } else if (request.url === '/netrc.json' && request.headers.authorization === 'Basic bW9jay11c2VyOm1vY2stc2VjcmV0') {
    response.writeHead(200);
    response.end(SCHEMA);
  } else {
    response.writeHead(401);
    response.end();
  }
});

test.before(() => Promise.all([storage.start(), github.start()]));
test.after(() => Promise.all([storage.stop(), github.stop()]));

function token(origin, secret, fix) {
  return { origin: `\`${origin}\``, authorization: `Bearer ${secret}`, fix };
}

function copiesWith(tokens, logLines, hostLogin = () => null) {
  let forgotten = 0;
  const copies = createSchemaUrlCopies({
    fetchText: fetchTextOrNull,
    fetchResponse: fetchResponseOrNull,
    credentials: {
      githubTokens: async () => tokens,
      hostLogin,
      forget: () => { forgotten += 1; },
    },
    githubApi: github.url(),
    logInfo: (line) => logLines.push(line),
  });
  return { copies, forgottenCount: () => forgotten };
}

test('a private release is read with the first token let in, the token never following the redirect', async () => {
  const logLines = [];
  const { copies } = copiesWith([
    token('GH_TOKEN', 'mock-stale-token', 'replace `GH_TOKEN`'),
    token('gh auth token', 'mock-good-token', 'run `gh auth login`'),
  ], logLines);
  assert.equal(await copies.schemaTextOf(RELEASE_LINK), SCHEMA);
  const refusals = logLines.filter((line) => line.includes('credential refused'));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /`GH_TOKEN` \(401 Bad credentials\): replace `GH_TOKEN`/);
});

test('every token refused reads nothing, names each, and forgets the tokens for the next read', async () => {
  const logLines = [];
  const { copies, forgottenCount } = copiesWith([token('gh auth token', 'mock-expired', 'run `gh auth login`')], logLines);
  assert.equal(await copies.schemaTextOf(RELEASE_LINK), null);
  assert.ok(logLines.some((line) => line.includes('`gh auth token` (401 Bad credentials): run `gh auth login`')));
  assert.equal(forgottenCount(), 1);
});

test('another host is read with its .netrc login', async () => {
  const login = {
    origin: 'the `.netrc` entry for 127.0.0.1',
    authorization: 'Basic bW9jay11c2VyOm1vY2stc2VjcmV0',
    fix: 'update the `.netrc` entry for 127.0.0.1',
  };
  const { copies } = copiesWith([], [], (host) => (host === '127.0.0.1' ? login : null));
  assert.equal(await copies.schemaTextOf(`${github.url()}/netrc.json`), SCHEMA);
});

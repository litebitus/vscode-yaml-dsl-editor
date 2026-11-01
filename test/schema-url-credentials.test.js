const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createSchemaUrlCopies } = require('../lib/schema-url-copies');
const { fetchResponseOrNull, fetchTextOrNull } = require('../lib/io');

const SCHEMA = '{"type": "object"}';
const GOOD_TOKEN = 'Bearer mock-good-token';
const BLIND_TOKEN = 'Bearer mock-blind-token';
const NETRC_LOGIN = 'Basic bW9jay11c2VyOm1vY2stc2VjcmV0';
const OPT_IN = '?yaml_dsl_machine_credentials=true';
const PUBLIC_LINK = 'https://github.com/mock-org/public-repo/releases/download/v1/mock.schema.json';
const PRIVATE_LINK = 'https://github.com/mock-org/private-repo/releases/download/mock/v1.0/mock.schema.json';
const PRIVATE_REPOSITORY = '/repos/mock-org/private-repo';
const RELEASE_ASSETS = { assets: [{ name: 'mock.schema.json', url: 'ASSET_URL' }] };

function serverOn(handle) {
  const server = http.createServer(handle);
  return {
    start: () => new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); }),
    stop: () => new Promise((resolve) => { server.close(resolve); }),
    url: () => `http://127.0.0.1:${server.address().port}`,
  };
}

function answer(response, status, text) {
  response.writeHead(status);
  response.end(text);
}

const storage = serverOn((request, response) => {
  if (request.headers.authorization) answer(response, 400);
  else answer(response, 200, SCHEMA);
});

const github = serverOn((request, response) => {
  const authorization = request.headers.authorization;
  const route = request.url;
  if (route.startsWith('/web/mock-org/public-repo/')) return answer(response, 200, SCHEMA);
  if (route.startsWith('/web/')) return answer(response, 404);
  if (route === '/netrc.json') return answer(response, authorization === NETRC_LOGIN ? 200 : 401, SCHEMA);
  if (authorization === BLIND_TOKEN) return answer(response, 404);
  if (authorization !== GOOD_TOKEN) return answer(response, 401);
  const listed = JSON.stringify(RELEASE_ASSETS).replace('ASSET_URL', `${github.url()}/assets/7`);
  if (route === PRIVATE_REPOSITORY) return answer(response, 200, '{}');
  if (route === `${PRIVATE_REPOSITORY}/releases/tags/mock%2Fv1.0`) return answer(response, 200, listed);
  if (route === `${PRIVATE_REPOSITORY}/releases/latest`) return answer(response, 200, listed);
  if (route === '/assets/7') {
    response.writeHead(302, { Location: `${storage.url()}/stored/7` });
    return response.end();
  }
  return answer(response, 404);
});

test.before(() => Promise.all([storage.start(), github.start()]));
test.after(() => Promise.all([storage.stop(), github.stop()]));

function token(origin, secret, fix) {
  return { origin: `\`${origin}\``, authorization: `Bearer ${secret}`, fix };
}

const STALE = token('GH_TOKEN', 'mock-stale-token', 'replace `GH_TOKEN`');
const GOOD = token('gh auth token', 'mock-good-token', 'run `gh auth login`');
const BLIND = token('GITHUB_TOKEN', 'mock-blind-token', 'replace `GITHUB_TOKEN`');

function onMockGithub(url) {
  return url.replace(/^https:\/\/(www\.)?github\.com/, `${github.url()}/web`);
}

function copiesWith(tokens, hostLogin = () => null) {
  const logLines = [];
  const counts = { tokenReads: 0, forgotten: 0 };
  const copies = createSchemaUrlCopies({
    fetchText: (url) => fetchTextOrNull(onMockGithub(url)),
    fetchResponse: (url, headers) => fetchResponseOrNull(onMockGithub(url), headers),
    credentials: {
      githubTokens: async () => {
        counts.tokenReads += 1;
        return tokens;
      },
      hostLogin,
      forget: () => { counts.forgotten += 1; },
    },
    githubApi: github.url(),
    logInfo: (line) => logLines.push(line),
  });
  return { copies, logLines, counts };
}

test('a link without the opt-in is read without credentials only, public or not', async () => {
  const { copies, counts } = copiesWith([GOOD]);
  assert.equal(await copies.schemaTextOf(PUBLIC_LINK), SCHEMA);
  assert.equal(await copies.schemaTextOf(PRIVATE_LINK), null);
  assert.equal(counts.tokenReads, 0);
});

test('an opted-in public link is read without credentials, a stale token never consulted', async () => {
  const { copies, counts } = copiesWith([STALE]);
  assert.equal(await copies.schemaTextOf(`${PUBLIC_LINK}${OPT_IN}`), SCHEMA);
  assert.equal(counts.tokenReads, 0);
});

test('an opted-in private release is read with the first token let in, the token never following the redirect',
  async () => {
    const { copies, logLines } = copiesWith([STALE, GOOD]);
    assert.equal(await copies.schemaTextOf(`${PRIVATE_LINK}${OPT_IN}`), SCHEMA);
    const refusals = logLines.filter((line) => line.includes('credential refused'));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /`GH_TOKEN` \(401 Bad credentials\): replace `GH_TOKEN`/);
  });

test('an opted-in link to the latest release, or through www.github.com, is read the same way', async () => {
  const { copies } = copiesWith([GOOD]);
  const latest = 'https://github.com/mock-org/private-repo/releases/latest/download/mock.schema.json';
  assert.equal(await copies.schemaTextOf(`${latest}${OPT_IN}`), SCHEMA);
  const www = PRIVATE_LINK.replace('https://github.com', 'https://www.github.com');
  assert.equal(await copies.schemaTextOf(`${www}${OPT_IN}`), SCHEMA);
});

test('a release or an asset the repository lacks is reported as missing, never as a credential', async () => {
  const { copies, logLines } = copiesWith([GOOD]);
  const absentRelease = 'https://github.com/mock-org/private-repo/releases/download/v9/mock.schema.json';
  const absentAsset = 'https://github.com/mock-org/private-repo/releases/download/mock/v1.0/other.json';
  assert.equal(await copies.schemaTextOf(`${absentRelease}${OPT_IN}`), null);
  assert.equal(await copies.schemaTextOf(`${absentAsset}${OPT_IN}`), null);
  const notes = logLines.filter((line) => !line.endsWith('not downloaded'));
  assert.deepEqual(notes.map((line) => line.replace(/^schema \S+ /, '')), [
    '`mock-org/private-repo` has no release `v9`',
    'release `mock/v1.0` of `mock-org/private-repo` has no asset `other.json`',
  ]);
});

test('a repository no token can see is reported by name, refused tokens named, and the tokens forgotten',
  async () => {
    const { copies, logLines, counts } = copiesWith([STALE, BLIND]);
    assert.equal(await copies.schemaTextOf(`${PRIVATE_LINK}${OPT_IN}`), null);
    assert.ok(logLines.some((line) => line.includes('`GH_TOKEN` (401 Bad credentials): replace `GH_TOKEN`')));
    assert.ok(logLines.some((line) => line.endsWith('no credential can see `mock-org/private-repo`')));
    assert.equal(counts.forgotten, 1);
  });

test('another host is read with its .netrc login only where the link opts in and is refused without it',
  async () => {
    const login = {
      origin: 'the `.netrc` entry for 127.0.0.1',
      authorization: NETRC_LOGIN,
      fix: 'update the `.netrc` entry for 127.0.0.1',
    };
    const { copies } = copiesWith([], (host) => (host === '127.0.0.1' ? login : null));
    assert.equal(await copies.schemaTextOf(`${github.url()}/netrc.json`), null);
    assert.equal(await copies.schemaTextOf(`${github.url()}/netrc.json${OPT_IN}`), SCHEMA);
  });

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchemaCredentials, netrcLoginOf } = require('../lib/schema-credentials');

const NETRC = [
  'machine mock.example login mock-user password mock-secret',
  'machine api.github.com',
  '  login mock-owner',
  '  password mock-netrc-token',
  'default login anyone password any-secret',
].join('\n');

test('a .netrc gives a host its machine entry, else the default entry', () => {
  assert.deepEqual(netrcLoginOf(NETRC, 'api.github.com'), { login: 'mock-owner', password: 'mock-netrc-token' });
  assert.deepEqual(netrcLoginOf(NETRC, 'other.example'), { login: 'anyone', password: 'any-secret' });
  assert.equal(netrcLoginOf('machine a.example login x password y', 'b.example'), null);
});

test('GitHub tokens come in gh\'s order: GH_TOKEN, GITHUB_TOKEN, the gh login, then .netrc', async () => {
  const credentials = createSchemaCredentials({
    env: { GH_TOKEN: 'mock-gh-token', GITHUB_TOKEN: 'mock-github-token' },
    ghLoginToken: async () => 'mock-login-token',
    netrcText: () => NETRC,
  });
  const tokens = await credentials.githubTokens();
  assert.deepEqual(tokens.map((token) => token.origin), [
    '`GH_TOKEN`',
    '`GITHUB_TOKEN`',
    '`gh auth token`',
    'the `.netrc` entry for api.github.com',
  ]);
  assert.equal(tokens[2].authorization, 'Bearer mock-login-token');
  assert.equal(
    credentials.hostLogin('mock.example').authorization,
    `Basic ${Buffer.from('mock-user:mock-secret').toString('base64')}`,
  );
});

test('a forgotten login is asked for again', async () => {
  let asked = 0;
  const credentials = createSchemaCredentials({
    env: {},
    ghLoginToken: async () => {
      asked += 1;
      return `mock-login-token-${asked}`;
    },
    netrcText: () => null,
  });
  await credentials.githubTokens();
  await credentials.githubTokens();
  assert.equal(asked, 1);
  credentials.forget();
  const [renewed] = await credentials.githubTokens();
  assert.equal(renewed.authorization, 'Bearer mock-login-token-2');
});

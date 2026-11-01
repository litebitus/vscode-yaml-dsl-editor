const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const GITHUB_API_HOST = 'api.github.com';
const GH_ANSWER_MILLISECONDS = 10000;

function ghLoginTokenOrNull(run = execFile) {
  return new Promise((resolve) => {
    run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: GH_ANSWER_MILLISECONDS }, (error, stdout) => {
      const token = error ? '' : String(stdout).trim();
      resolve(token || null);
    });
  });
}

function netrcTextOrNull(env = process.env) {
  const netrcPath = env.NETRC || path.join(env.HOME || os.homedir(), '.netrc');
  try {
    return fs.readFileSync(netrcPath, 'utf8');
  } catch {
    return null;
  }
}

function netrcLoginOf(text, host) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let found = null;
  let fallback = null;
  let current = null;
  const finish = () => {
    if (!current) return;
    if (current.isHost && !found) found = { login: current.login, password: current.password };
    if (current.isDefault && !fallback) fallback = { login: current.login, password: current.password };
    current = null;
  };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === 'machine') {
      finish();
      index += 1;
      current = { isHost: words[index] === host, isDefault: false, login: '', password: '' };
    } else if (word === 'default') {
      finish();
      current = { isHost: false, isDefault: true, login: '', password: '' };
    } else if (word === 'login' && current) {
      index += 1;
      current.login = words[index] || '';
    } else if (word === 'password' && current) {
      index += 1;
      current.password = words[index] || '';
    } else if (word === 'account') {
      index += 1;
    } else if (word === 'macdef') {
      finish();
      index += 1;
    }
  }
  finish();
  return found || fallback;
}

function basicCredential(host, login) {
  return {
    origin: `the \`.netrc\` entry for ${host}`,
    authorization: `Basic ${Buffer.from(`${login.login}:${login.password}`).toString('base64')}`,
    fix: `update the \`.netrc\` entry for ${host}`,
  };
}

function createSchemaCredentials({ env = process.env, ghLoginToken = ghLoginTokenOrNull, netrcText = () => netrcTextOrNull(env) } = {}) {
  let githubTokens = null;
  let netrc;

  function hostLogin(host) {
    if (netrc === undefined) netrc = netrcText();
    const login = netrcLoginOf(netrc, host);
    return login ? basicCredential(host, login) : null;
  }

  async function readGithubTokens() {
    const tokens = [];
    for (const variable of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      if (env[variable]) {
        tokens.push({ origin: `\`${variable}\``, authorization: `Bearer ${env[variable]}`, fix: `replace \`${variable}\`` });
      }
    }
    const loginToken = await ghLoginToken();
    if (loginToken) {
      tokens.push({ origin: '`gh auth token`', authorization: `Bearer ${loginToken}`, fix: 'run `gh auth login`' });
    }
    const netrcLogin = hostLogin(GITHUB_API_HOST);
    if (netrcLogin) tokens.push(netrcLogin);
    return tokens;
  }

  return {
    githubTokens: () => {
      if (!githubTokens) githubTokens = readGithubTokens();
      return githubTokens;
    },
    hostLogin,
    forget: () => {
      githubTokens = null;
      netrc = undefined;
    },
  };
}

module.exports = { createSchemaCredentials, netrcLoginOf };

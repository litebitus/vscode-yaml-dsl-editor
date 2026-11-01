const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EDITOR_PARAMETER_PREFIX = 'yaml_dsl_';
const MAX_AGE_PARAMETER = 'yaml_dsl_max_age_days';
const WHOLE_DAYS = /^(0|[1-9][0-9]*)$/;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const KEPT_COPIES_FOLDER = 'schema-urls';
const GITHUB_API = 'https://api.github.com';
const RELEASE_LINK = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/releases\/download\/([^?#]+)\/([^/?#]+)$/;
const REFUSED_STATUSES = [401, 403];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function refusalOf(credential, status) {
  const reason = {
    401: '401 Bad credentials',
    404: '404, which GitHub answers to a token that cannot see the release',
  }[status] || String(status);
  return `the server refused the credential from ${credential.origin} (${reason}): ${credential.fix}`;
}

function editorParametersOf(url) {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return { fetchUrl: url, maxAgeDays: null, problem: null };
  const passedParameters = [];
  let maxAgeDays = null;
  let problem = null;
  for (const parameter of url.slice(queryStart + 1).split('&')) {
    const name = parameter.split('=')[0];
    if (!name.startsWith(EDITOR_PARAMETER_PREFIX)) {
      passedParameters.push(parameter);
    } else if (name !== MAX_AGE_PARAMETER) {
      problem = problem || `\`${name}\` is not a parameter the editor reads`;
    } else if (!parameter.includes('=') || !WHOLE_DAYS.test(parameter.slice(name.length + 1))) {
      problem = problem || `\`${MAX_AGE_PARAMETER}\` must be a whole number of days`;
    } else {
      maxAgeDays = Number(parameter.slice(name.length + 1)) || null;
    }
  }
  const base = url.slice(0, queryStart);
  const fetchUrl = passedParameters.length > 0 ? `${base}?${passedParameters.join('&')}` : base;
  return { fetchUrl, maxAgeDays, problem };
}

function keptCopyFileOf(folder, url) {
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');
  return path.join(folder, KEPT_COPIES_FOLDER, `${urlHash}.json`);
}

function createSchemaUrlCopies({
  fetchText,
  fetchResponse,
  credentials = null,
  githubApi = GITHUB_API,
  logInfo = () => {},
  now = Date.now,
}) {
  let storageFolder = null;
  const keptByUrl = new Map();
  const readingByUrl = new Map();
  const logSchemaRead = (url, outcome) => logInfo(`schema ${url} ${outcome}`);

  function storedCopyOf(url) {
    if (!storageFolder) return null;
    try {
      const stored = JSON.parse(fs.readFileSync(keptCopyFileOf(storageFolder, url), 'utf8'));
      return stored.url === url ? stored : null;
    } catch {
      return null;
    }
  }

  function keep(url, keptCopy) {
    keptByUrl.set(url, keptCopy);
    if (!storageFolder) return;
    try {
      const filePath = keptCopyFileOf(storageFolder, url);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(`${filePath}.writing`, JSON.stringify({ url, ...keptCopy }));
      fs.renameSync(`${filePath}.writing`, filePath);
    } catch {
      return;
    }
  }

  async function releaseAnswerOf([, owner, repository, tag, asset], tokens, conditionHeaders) {
    const refusals = [];
    const releaseUrl = `${githubApi}/repos/${owner}/${repository}/releases/tags/${tag.replaceAll('/', '%2F')}`;
    for (const token of tokens) {
      const listing = await fetchResponse(releaseUrl, {
        Authorization: token.authorization,
        Accept: 'application/vnd.github+json',
      });
      if (!listing) return { response: null, refusals };
      if (listing.status !== 200) {
        refusals.push(refusalOf(token, listing.status));
        continue;
      }
      let listed = null;
      try {
        listed = (JSON.parse(listing.text).assets || []).find((entry) => entry.name === asset);
      } catch {
        return { response: null, refusals };
      }
      if (!listed) return { response: { status: 404 }, refusals };
      const download = await fetchResponse(listed.url, {
        ...conditionHeaders,
        Authorization: token.authorization,
        Accept: 'application/octet-stream',
      });
      if (download && REFUSED_STATUSES.includes(download.status)) {
        refusals.push(refusalOf(token, download.status));
        continue;
      }
      return { response: download, refusals };
    }
    credentials.forget();
    return { response: null, refusals };
  }

  async function answerOf(url, conditionHeaders) {
    const release = url.match(RELEASE_LINK);
    const tokens = release && credentials ? await credentials.githubTokens() : [];
    if (release && tokens.length) return releaseAnswerOf(release, tokens, conditionHeaders);
    const host = hostOf(url);
    const login = credentials && host ? credentials.hostLogin(host) : null;
    const headers = login ? { ...conditionHeaders, Authorization: login.authorization } : conditionHeaders;
    const response = await fetchResponse(url, headers);
    if (login && response && REFUSED_STATUSES.includes(response.status)) {
      return { response: null, refusals: [refusalOf(login, response.status)] };
    }
    return { response, refusals: [] };
  }

  async function readsWithCredentials(url) {
    if (!credentials) return false;
    if (RELEASE_LINK.test(url)) return (await credentials.githubTokens()).length > 0;
    const host = hostOf(url);
    return Boolean(host && credentials.hostLogin(host));
  }

  async function uncachedTextOf(url) {
    if (!(await readsWithCredentials(url))) return fetchText(url);
    const { response, refusals } = await answerOf(url, {});
    for (const refusal of refusals) logSchemaRead(url, `credential refused: ${refusal}`);
    return response && response.status === 200 ? response.text : null;
  }

  async function keptTextOf(url, maxAgeDays) {
    if (!keptByUrl.has(url)) keptByUrl.set(url, storedCopyOf(url));
    const kept = keptByUrl.get(url);
    const keptAge = kept ? now() - kept.confirmedAt : null;
    if (kept && keptAge < maxAgeDays * DAY_MILLISECONDS) {
      logSchemaRead(url, `kept copy used, ${(keptAge / DAY_MILLISECONDS).toFixed(1)} days old`);
      return kept.text;
    }
    const conditionHeaders = {};
    if (kept && kept.entityTag) conditionHeaders['If-None-Match'] = kept.entityTag;
    else if (kept && kept.lastModified) conditionHeaders['If-Modified-Since'] = kept.lastModified;
    const { response, refusals } = await answerOf(url, conditionHeaders);
    for (const refusal of refusals) logSchemaRead(url, `credential refused: ${refusal}`);
    if (response && response.status === 304 && kept) {
      keep(url, { ...kept, confirmedAt: now() });
      return kept.text;
    }
    if (response && response.status === 200) {
      const { text, entityTag, lastModified } = response;
      keep(url, { text, entityTag, lastModified, confirmedAt: now() });
      logSchemaRead(url, 'downloaded');
      return text;
    }
    const failure = response ? `server answered ${response.status}` : 'server unreachable';
    logSchemaRead(url, kept ? `kept copy used, ${failure}` : `not downloaded, ${failure}`);
    return kept ? kept.text : null;
  }

  async function schemaTextOf(location) {
    const { fetchUrl, maxAgeDays } = editorParametersOf(location);
    if (maxAgeDays === null) {
      const text = await uncachedTextOf(fetchUrl);
      logSchemaRead(fetchUrl, text === null ? 'not downloaded' : 'downloaded');
      return text;
    }
    if (!readingByUrl.has(fetchUrl)) {
      readingByUrl.set(fetchUrl, keptTextOf(fetchUrl, maxAgeDays).finally(() => readingByUrl.delete(fetchUrl)));
    }
    return readingByUrl.get(fetchUrl);
  }

  return {
    schemaTextOf,
    setStorageFolder: (folder) => {
      storageFolder = folder || null;
      keptByUrl.clear();
    },
  };
}

module.exports = { editorParametersOf, createSchemaUrlCopies };

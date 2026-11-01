const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EDITOR_PARAMETER_PREFIX = 'yaml_dsl_';
const MAX_AGE_PARAMETER = 'yaml_dsl_max_age_days';
const MACHINE_CREDENTIALS_PARAMETER = 'yaml_dsl_machine_credentials';
const MACHINE_CREDENTIALS_VALUES = { true: true, false: false };
const WHOLE_DAYS = /^(0|[1-9][0-9]*)$/;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const KEPT_COPIES_FOLDER = 'schema-urls';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RELEASES_LINK = /^https:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/releases\/([^?#]+)(?:[?#].*)?$/;
const LATEST_RELEASE_ASSET = /^latest\/download\/([^/]+)$/;
const TAGGED_RELEASE_ASSET = /^download\/(.+)\/([^/]+)$/;
const REFUSED_STATUSES = [401, 403];
const GITHUB_HIDDEN_STATUS = 404;
const JSON_ACCEPT = 'application/vnd.github+json';

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function refusalOf(credential, status) {
  const reason = status === 401 ? '401 Bad credentials' : String(status);
  const refused = `the server refused the credential from ${credential.origin} (${reason})`;
  return `credential refused: ${refused}: ${credential.fix}`;
}

/**
 * The repository a GitHub link under `<owner>/<repo>/releases/` names, and the
 * release and asset its path reads, `null` for any other link.
 */
function githubReleaseOf(url) {
  const match = url.match(GITHUB_RELEASES_LINK);
  if (!match) return null;
  const [, owner, repository, releasePath] = match;
  const latest = releasePath.match(LATEST_RELEASE_ASSET);
  if (latest) return { owner, repository, apiPath: 'latest', name: 'the latest release', asset: latest[1] };
  const tagged = releasePath.match(TAGGED_RELEASE_ASSET);
  if (!tagged) return { owner, repository, apiPath: null, name: null, asset: null };
  const [, tag, asset] = tagged;
  return { owner, repository, apiPath: `tags/${tag.replaceAll('/', '%2F')}`, name: `release \`${tag}\``, asset };
}

function editorParametersOf(url) {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return { fetchUrl: url, maxAgeDays: null, machineCredentials: false, problem: null };
  const passedParameters = [];
  let maxAgeDays = null;
  let machineCredentials = false;
  let problem = null;
  for (const parameter of url.slice(queryStart + 1).split('&')) {
    const name = parameter.split('=')[0];
    const value = parameter.includes('=') ? parameter.slice(name.length + 1) : null;
    if (!name.startsWith(EDITOR_PARAMETER_PREFIX)) {
      passedParameters.push(parameter);
    } else if (name === MACHINE_CREDENTIALS_PARAMETER) {
      if (Object.hasOwn(MACHINE_CREDENTIALS_VALUES, value)) machineCredentials = MACHINE_CREDENTIALS_VALUES[value];
      else problem = problem || `\`${MACHINE_CREDENTIALS_PARAMETER}\` must be \`true\` or \`false\``;
    } else if (name !== MAX_AGE_PARAMETER) {
      problem = problem || `\`${name}\` is not a parameter the editor reads`;
    } else if (value === null || !WHOLE_DAYS.test(value)) {
      problem = problem || `\`${MAX_AGE_PARAMETER}\` must be a whole number of days`;
    } else {
      maxAgeDays = Number(value) || null;
    }
  }
  const base = url.slice(0, queryStart);
  const fetchUrl = passedParameters.length > 0 ? `${base}?${passedParameters.join('&')}` : base;
  return { fetchUrl, maxAgeDays, machineCredentials, problem };
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

  /**
   * A GitHub release asset read through the API with each token in turn, and what
   * is known when none reads it: a refused token, a release or asset the
   * repository lacks, or a repository no token can see.
   */
  async function releaseAnswerOf(release, tokens, conditionHeaders) {
    const notes = [];
    const repositoryName = `\`${release.owner}/${release.repository}\``;
    const repositoryUrl = `${githubApi}/repos/${release.owner}/${release.repository}`;
    let missing = null;
    for (const token of tokens) {
      const authorization = { Authorization: token.authorization };
      const listing = await fetchResponse(`${repositoryUrl}/releases/${release.apiPath}`, {
        ...authorization,
        Accept: JSON_ACCEPT,
      });
      if (!listing) return { response: null, notes };
      if (REFUSED_STATUSES.includes(listing.status)) {
        notes.push(refusalOf(token, listing.status));
        continue;
      }
      if (listing.status !== 200) {
        const seen = await fetchResponse(repositoryUrl, { ...authorization, Accept: JSON_ACCEPT });
        if (seen && seen.status === 200) {
          missing = `${repositoryName} has no ${release.name}`;
          break;
        }
        continue;
      }
      let listed = null;
      try {
        listed = (JSON.parse(listing.text).assets || []).find((entry) => entry.name === release.asset);
      } catch {
        return { response: null, notes };
      }
      if (!listed) {
        missing = `${release.name} of ${repositoryName} has no asset \`${release.asset}\``;
        break;
      }
      const download = await fetchResponse(listed.url, {
        ...conditionHeaders,
        ...authorization,
        Accept: 'application/octet-stream',
      });
      if (download && REFUSED_STATUSES.includes(download.status)) {
        notes.push(refusalOf(token, download.status));
        continue;
      }
      return { response: download, notes };
    }
    credentials.forget();
    notes.push(missing || `no credential can see ${repositoryName}`);
    return { response: null, notes };
  }

  async function hostAnswerOf(url, conditionHeaders) {
    const host = hostOf(url);
    const login = host ? credentials.hostLogin(host) : null;
    if (!login) return { response: null, notes: [] };
    const response = await fetchResponse(url, { ...conditionHeaders, Authorization: login.authorization });
    if (response && REFUSED_STATUSES.includes(response.status)) {
      return { response: null, notes: [refusalOf(login, response.status)] };
    }
    return { response, notes: [] };
  }

  /**
   * The answer to `url`: read without credentials, and with the machine's only
   * where `machineCredentials` opts in and that read is refused.
   */
  async function answerOf(url, conditionHeaders, machineCredentials) {
    const anonymous = await fetchResponse(url, conditionHeaders);
    if (!machineCredentials || !credentials || !anonymous) return { response: anonymous, notes: [] };
    const githubRelease = githubReleaseOf(url);
    const refused = REFUSED_STATUSES.includes(anonymous.status)
      || (githubRelease !== null && anonymous.status === GITHUB_HIDDEN_STATUS);
    if (!refused) return { response: anonymous, notes: [] };
    let answer = { response: null, notes: [] };
    if (githubRelease === null) answer = await hostAnswerOf(url, conditionHeaders);
    else if (githubRelease.apiPath !== null) {
      const tokens = await credentials.githubTokens();
      if (tokens.length > 0) answer = await releaseAnswerOf(githubRelease, tokens, conditionHeaders);
    }
    return { response: answer.response || anonymous, notes: answer.notes };
  }

  async function uncachedTextOf(url, machineCredentials) {
    if (!machineCredentials) return fetchText(url);
    const { response, notes } = await answerOf(url, {}, true);
    for (const note of notes) logSchemaRead(url, note);
    return response && response.status === 200 ? response.text : null;
  }

  async function keptTextOf(url, maxAgeDays, machineCredentials) {
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
    const { response, notes } = await answerOf(url, conditionHeaders, machineCredentials);
    for (const note of notes) logSchemaRead(url, note);
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
    const { fetchUrl, maxAgeDays, machineCredentials } = editorParametersOf(location);
    if (maxAgeDays === null) {
      const text = await uncachedTextOf(fetchUrl, machineCredentials);
      logSchemaRead(fetchUrl, text === null ? 'not downloaded' : 'downloaded');
      return text;
    }
    if (!readingByUrl.has(fetchUrl)) {
      const reading = keptTextOf(fetchUrl, maxAgeDays, machineCredentials);
      readingByUrl.set(fetchUrl, reading.finally(() => readingByUrl.delete(fetchUrl)));
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

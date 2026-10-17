const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EDITOR_PARAMETER_PREFIX = 'yaml_dsl_';
const MAX_AGE_PARAMETER = 'yaml_dsl_max_age_days';
const WHOLE_DAYS = /^(0|[1-9][0-9]*)$/;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const KEPT_COPIES_FOLDER = 'schema-urls';

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

function createSchemaUrlCopies({ fetchText, fetchResponse, logInfo = () => {}, now = Date.now }) {
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
    const response = await fetchResponse(url, conditionHeaders);
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
      const text = await fetchText(fetchUrl);
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

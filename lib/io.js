const fs = require('fs');
const { execFile } = require('child_process');

const TERRAFORM_ANSWER_MILLISECONDS = 10000;
const FETCH_ANSWER_MILLISECONDS = 10000;

async function readFileOrNull(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fetchResponseOrNull(url, headers = {}, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_ANSWER_MILLISECONDS) });
    return {
      status: response.status,
      text: response.status === 200 ? await response.text() : null,
      entityTag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  } catch {
    return null;
  }
}

async function fetchTextOrNull(url, fetchImpl = globalThis.fetch) {
  const response = await fetchResponseOrNull(url, {}, fetchImpl);
  return response && response.status === 200 ? response.text : null;
}

function terraformFunctionsOrNull(run = execFile) {
  return new Promise((resolve) => {
    run(
      'terraform',
      ['metadata', 'functions', '-json'],
      { timeout: TERRAFORM_ANSWER_MILLISECONDS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

module.exports = { readFileOrNull, fetchResponseOrNull, fetchTextOrNull, terraformFunctionsOrNull };

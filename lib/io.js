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

async function fetchTextOrNull(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_ANSWER_MILLISECONDS) });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
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

module.exports = { readFileOrNull, fetchTextOrNull, terraformFunctionsOrNull };

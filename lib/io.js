const fs = require('fs');

async function readFileOrNull(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fetchTextOrNull(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

module.exports = { readFileOrNull, fetchTextOrNull };

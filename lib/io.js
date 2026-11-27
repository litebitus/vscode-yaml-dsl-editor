const fs = require('fs');
const { execFile } = require('child_process');

const TERRAFORM_ANSWER_MILLISECONDS = 10000;

async function readFileOrNull(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileStatOrNull(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return { modifiedMilliseconds: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

async function folderEntriesOrNull(folderPath) {
  try {
    const folderEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    return folderEntries.map((folderEntry) => ({
      name: folderEntry.name,
      isFolder: folderEntry.isDirectory(),
    }));
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

module.exports = {
  readFileOrNull,
  fileStatOrNull,
  folderEntriesOrNull,
  terraformFunctionsOrNull,
};

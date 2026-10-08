const fs = require('fs');
const path = require('path');

const UNRELEASED_HEADING = '## Unreleased';
const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.md');
const MISSING_HEADING_MESSAGE = `CHANGELOG.md has no "${UNRELEASED_HEADING}" heading to release`;

function hasUnreleasedHeading(text) {
  return text.split('\n').includes(UNRELEASED_HEADING);
}

function releasedChangelogText(text, version, date) {
  if (!hasUnreleasedHeading(text)) throw new Error(MISSING_HEADING_MESSAGE);
  return text
    .split('\n')
    .map((line) => (line === UNRELEASED_HEADING ? `## ${version} - ${date}` : line))
    .join('\n');
}

function localDateOf(moment) {
  const month = String(moment.getMonth() + 1).padStart(2, '0');
  const day = String(moment.getDate()).padStart(2, '0');
  return `${moment.getFullYear()}-${month}-${day}`;
}

function runChangelogRelease(argv, env) {
  const text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  if (argv.includes('--check')) {
    if (!hasUnreleasedHeading(text)) throw new Error(MISSING_HEADING_MESSAGE);
    return;
  }
  if (!env.npm_package_version) throw new Error('npm_package_version is not set; run this from npm version');
  fs.writeFileSync(CHANGELOG_PATH, releasedChangelogText(text, env.npm_package_version, localDateOf(new Date())));
}

if (require.main === module) {
  try {
    runChangelogRelease(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { UNRELEASED_HEADING, hasUnreleasedHeading, releasedChangelogText, localDateOf };

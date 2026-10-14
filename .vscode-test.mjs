import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const versions = pkg.vscodeTestVersions;
if (!Array.isArray(versions) || versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))) {
  throw new Error('package.json vscodeTestVersions must be exact x.y.z pins');
}

const fixturesFolder = fileURLToPath(new URL('./test/fixtures', import.meta.url));
const runFolder = realpathSync(mkdtempSync(path.join(tmpdir(), 'yaml-dsl-editor-integration-')));
const writableFolder = path.join(runFolder, 'writable');
mkdirSync(writableFolder);
copyFileSync(path.join(fixturesFolder, 'yaml-dsl.yml'), path.join(writableFolder, 'yaml-dsl.yml'));
const concernFolder = path.join(runFolder, 'concerns');
cpSync(fileURLToPath(new URL('./test/concern-fixtures', import.meta.url)), concernFolder, { recursive: true });
const workspaceFile = path.join(runFolder, 'integration.code-workspace');
const workspaceFolders = [{ path: fixturesFolder }, { path: writableFolder }, { path: concernFolder }];
writeFileSync(workspaceFile, JSON.stringify({ folders: workspaceFolders }));

const sha256Of = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const plantedStackFolder = path.join(writableFolder, 'planted-marks');
const plantedLayerText = 'mocktype:\n  shared:\n    size: 1\n';
const plantedLayerFolders = [
  plantedStackFolder,
  path.join(plantedStackFolder, 'one'),
  path.join(plantedStackFolder, 'two'),
];
for (const layerFolder of plantedLayerFolders) {
  mkdirSync(layerFolder, { recursive: true });
  writeFileSync(path.join(layerFolder, 'mock.yml'), plantedLayerText);
}

function plantedMarksStoreText() {
  const position = { line: 0, character: 8 };
  const suggestion = {
    stackId: path.join(plantedStackFolder, 'mock.yml'),
    id: 'mock-planted-move',
    kind: 'move',
    path: ['mocktype'],
    overlayCount: 2,
    holders: ['one', 'two'],
    absent: [],
    differences: [],
    schemaGroups: [],
    optOutFailures: [],
    optOutConditionalFields: [],
  };
  return JSON.stringify({
    version: 2,
    build: 'mock-older-build-hash',
    files: {
      [`file://${path.join(plantedStackFolder, 'one', 'mock.yml')}`]: {
        stackId: suggestion.stackId,
        textHash: sha256Of(plantedLayerText),
        marks: [{ range: { start: position, end: position }, suggestion }],
      },
    },
  });
}

function userDataWithPlantedMarks() {
  const userDataFolder = mkdtempSync(path.join(tmpdir(), 'yaml-dsl-ud-'));
  const extensionStorage = path.join(userDataFolder, 'User', 'globalStorage', `${pkg.publisher}.${pkg.name}`);
  const storeFolder = path.join(extensionStorage, sha256Of(`file://${workspaceFile}`));
  mkdirSync(storeFolder, { recursive: true });
  writeFileSync(path.join(storeFolder, 'suggestion-marks.json'), plantedMarksStoreText());
  return userDataFolder;
}

const base = {
  files: 'test/integration/**/*.test.js',
  workspaceFolder: workspaceFile,
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
};

export default defineConfig(versions.map((version) => ({
  label: version,
  version,
  ...base,
  launchArgs: [`--user-data-dir=${userDataWithPlantedMarks()}`],
})));

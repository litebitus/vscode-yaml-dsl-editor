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

const editorRepoFolder = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const workingFolder = realpathSync(process.cwd());
if (workingFolder !== editorRepoFolder) {
  throw new Error(`the integration tests run from the editor repo through \`make test-all\`, `
    + `because VS Code downloads into the working directory; the working directory is `
    + `${workingFolder}, the editor repo is ${editorRepoFolder}`);
}

const fixturesFolder = fileURLToPath(new URL('./test/fixtures', import.meta.url));
const sha256Of = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const plantedLayerText = 'mocktype:\n  shared:\n    size: 1\n';

function integrationRunOf() {
  const runFolder = realpathSync(mkdtempSync(path.join(tmpdir(), 'yaml-dsl-editor-integration-')));
  const writableFolder = path.join(runFolder, 'writable');
  mkdirSync(writableFolder);
  copyFileSync(
    path.join(fixturesFolder, 'yaml-dsl.yml'),
    path.join(writableFolder, 'yaml-dsl.yml'),
  );
  const concernFolder = path.join(runFolder, 'concerns');
  cpSync(
    fileURLToPath(new URL('./test/concern-fixtures', import.meta.url)),
    concernFolder,
    { recursive: true },
  );
  const settingsFolder = path.join(runFolder, 'settings');
  cpSync(
    fileURLToPath(new URL('./test/settings-fixtures', import.meta.url)),
    settingsFolder,
    { recursive: true },
  );
  const workspaceFile = path.join(runFolder, 'integration.code-workspace');
  const workspaceFolders = [
    { path: fixturesFolder },
    { path: writableFolder },
    { path: concernFolder },
    { path: settingsFolder },
  ];
  writeFileSync(workspaceFile, JSON.stringify({
    folders: workspaceFolders,
    settings: {
      'files.associations': {
        '/mock-stale/**/*.yaml': 'yaml-dsl',
        '*.mock-workspace': 'plaintext',
      },
    },
  }));

  const plantedStackFolder = path.join(writableFolder, 'planted-marks');
  const plantedLayerFolders = [
    plantedStackFolder,
    path.join(plantedStackFolder, 'one'),
    path.join(plantedStackFolder, 'two'),
  ];
  for (const layerFolder of plantedLayerFolders) {
    mkdirSync(layerFolder, { recursive: true });
    writeFileSync(path.join(layerFolder, 'mock.yml'), plantedLayerText);
  }
  return { workspaceFile, plantedStackFolder };
}

function plantedMarksStoreText(plantedStackFolder) {
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

function userDataWithPlantedMarks(integrationRun) {
  const userDataFolder = mkdtempSync(path.join(tmpdir(), 'yaml-dsl-ud-'));
  mkdirSync(path.join(userDataFolder, 'User'), { recursive: true });
  writeFileSync(path.join(userDataFolder, 'User', 'settings.json'), JSON.stringify({
    'chat.disableAIFeatures': true,
    'files.associations': {
      '*.mock-user': 'plaintext',
      [`${fixturesFolder.replaceAll('\\', '/')}/associated/./*.yaml`]: 'yaml-dsl',
    },
  }));
  const extensionStorage = path.join(userDataFolder, 'User', 'globalStorage', `${pkg.publisher}.${pkg.name}`);
  const workspaceFileHash = sha256Of(`file://${integrationRun.workspaceFile}`);
  const storeFolder = path.join(extensionStorage, workspaceFileHash);
  mkdirSync(storeFolder, { recursive: true });
  writeFileSync(
    path.join(storeFolder, 'suggestion-marks.json'),
    plantedMarksStoreText(integrationRun.plantedStackFolder),
  );
  return userDataFolder;
}

const base = {
  files: 'test/integration/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 5000,
  },
};

function runConfigurationOf(integrationRun) {
  return {
    ...base,
    workspaceFolder: integrationRun.workspaceFile,
    launchArgs: [`--user-data-dir=${userDataWithPlantedMarks(integrationRun)}`],
  };
}

const targetIde = process.env.TARGET_IDE_EXECUTABLE
  ? [{
    label: process.env.TARGET_IDE_LABEL,
    useInstallation: { fromPath: process.env.TARGET_IDE_EXECUTABLE },
    ...runConfigurationOf(integrationRunOf()),
  }]
  : null;

export default defineConfig(targetIde || versions.map((version) => ({
  label: version,
  version,
  ...runConfigurationOf(integrationRunOf()),
})));

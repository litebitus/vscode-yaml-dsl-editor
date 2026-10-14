import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const runFolder = mkdtempSync(path.join(tmpdir(), 'yaml-dsl-editor-integration-'));
const writableFolder = path.join(runFolder, 'writable');
mkdirSync(writableFolder);
copyFileSync(path.join(fixturesFolder, 'yaml-dsl.yml'), path.join(writableFolder, 'yaml-dsl.yml'));
const workspaceFile = path.join(runFolder, 'integration.code-workspace');
writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: fixturesFolder }, { path: writableFolder }] }));

const base = {
  files: 'test/integration/**/*.test.js',
  workspaceFolder: workspaceFile,
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
};

export default defineConfig(versions.map((version) => ({ label: version, version, ...base })));

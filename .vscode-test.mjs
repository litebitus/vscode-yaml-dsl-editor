import { readFileSync } from 'node:fs';
import { defineConfig } from '@vscode/test-cli';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const versions = pkg.vscodeTestVersions;
if (!Array.isArray(versions) || versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))) {
  throw new Error('package.json vscodeTestVersions must be exact x.y.z pins');
}

const base = {
  files: 'test/integration/**/*.test.js',
  workspaceFolder: 'test/fixtures',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
};

export default defineConfig(versions.map((version) => ({ label: version, version, ...base })));

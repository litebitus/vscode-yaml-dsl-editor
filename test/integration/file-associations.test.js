const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { WAIT_DEADLINE_MILLISECONDS, fixtureCopy } = require('./editor-hints');
const { isolateEachTest } = require('./test-isolation');

const CONFIG_FILE = 'yaml-dsl.yml';

function associations() {
  return vscode.workspace.getConfiguration('files').get('associations') || {};
}

async function associationsBecome(holds) {
  const deadline = Date.now() + WAIT_DEADLINE_MILLISECONDS;
  while (Date.now() < deadline && !holds(associations())) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.ok(holds(associations()), JSON.stringify(associations()));
}

suite('file associations', () => {
  isolateEachTest();

  test('a config\'s globs are associated with YAML DSL, so its files open as YAML DSL before any extension sees them, '
    + 'and a changed glob replaces its association', async () => {
    const folder = fixtureCopy('associated');
    const yamlGlob = `${folder.replaceAll('\\', '/')}/*.yaml`;
    const ymlGlob = `${folder.replaceAll('\\', '/')}/*.yml`;
    await associationsBecome((held) => held[yamlGlob] === 'yaml-dsl');
    const created = path.join(folder, 'mock-created.yaml');
    fs.writeFileSync(created, 'mock: value\n');
    const opened = await vscode.workspace.openTextDocument(created);
    assert.equal(opened.languageId, 'yaml-dsl');
    const configPath = path.join(folder, CONFIG_FILE);
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('*.yaml', '*.yml'));
    await associationsBecome((held) => held[ymlGlob] === 'yaml-dsl' && !Object.hasOwn(held, yamlGlob));
  });

  test('a YAML DSL entry no config states is dropped, another language\'s entry is kept, '
    + 'and no user entry is copied into the workspace', async () => {
    const folder = fixtureCopy('associated', 'associated-kept');
    const yamlGlob = `${folder.replaceAll('\\', '/')}/*.yaml`;
    await associationsBecome((held) => held[yamlGlob] === 'yaml-dsl');
    const configPath = path.join(folder, CONFIG_FILE);
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('*.yaml', '*.yml'));
    await associationsBecome((held) => !Object.hasOwn(held, yamlGlob));
    const inspected = vscode.workspace.getConfiguration('files').inspect('associations');
    assert.equal(Object.hasOwn(inspected.workspaceValue, '/mock-stale/**/*.yaml'), false);
    assert.equal(inspected.workspaceValue['*.mock-workspace'], 'plaintext');
    assert.equal(Object.hasOwn(inspected.workspaceValue, '*.mock-user'), false);
    assert.equal(inspected.globalValue['*.mock-user'], 'plaintext');
  });

  test('a glob the user settings already associate, spelled another way, is not added to the workspace', async () => {
    const fixtures = vscode.workspace.workspaceFolders[0].uri.fsPath.replaceAll('\\', '/');
    const copyGlob = `${fixtureCopy('associated', 'associated-spelled').replaceAll('\\', '/')}/*.yaml`;
    await associationsBecome((held) => held[copyGlob] === 'yaml-dsl');
    const inspected = vscode.workspace.getConfiguration('files').inspect('associations');
    assert.equal(inspected.globalValue[`${fixtures}/associated/./*.yaml`], 'yaml-dsl');
    assert.equal(Object.hasOwn(inspected.workspaceValue, `${fixtures}/associated/*.yaml`), false);
  });
});

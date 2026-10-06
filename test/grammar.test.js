const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const grammarPath = path.join(__dirname, '..', 'syntaxes', 'yaml-dsl.tmLanguage.json');

async function loadGrammar() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (text) => new oniguruma.OnigString(text),
    }),
    loadGrammar: async () => textmate.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath),
  });
  return registry.loadGrammar('source.yaml.dsl');
}

const grammarLoading = loadGrammar();

async function scopedText(line, scopeName) {
  const grammar = await grammarLoading;
  return grammar.tokenizeLine(line, textmate.INITIAL).tokens
    .filter((token) => token.scopes.some((scope) => scope.startsWith(scopeName)))
    .map((token) => line.slice(token.startIndex, token.endIndex))
    .join('');
}

test('an apostrophe or a quote inside plain text opens no string', async () => {
  assert.equal(await scopedText("name: the mock player's balance", 'string'), '');
  assert.equal(await scopedText('note: a "mock" word', 'string'), '');
  assert.equal(await scopedText("note: rock 'n roll", 'string'), '');
});

test('a quote opens a string where a scalar starts', async () => {
  assert.equal((await scopedText("quoted: 'mock text'", 'string')).trim(), "'mock text'");
  assert.equal((await scopedText('quoted:   "mock text"', 'string')).trim(), '"mock text"');
  assert.equal((await scopedText("  - 'mock item'", 'string')).trim(), "'mock item'");
  assert.equal(await scopedText("list: ['mock', it's]", 'string'), "'mock'");
  assert.equal((await scopedText("map: { key: 'mock' }", 'string')).trim(), "'mock'");
  assert.equal(await scopedText("'mock key': value", 'string'), "'mock key'");
});

test('a doubled single quote is an escape inside a single-quoted string', async () => {
  const line = "quoted: 'mock ''escaped'' text'";
  assert.equal((await scopedText(line, 'string')).trim(), "'mock ''escaped'' text'");
  assert.equal(await scopedText(line, 'constant.character.escape'), "''''");
});

test('a # starts a comment only at the start of a line or after whitespace', async () => {
  assert.equal(await scopedText('messages: ../mock/protocol.yml#mock', 'comment'), '');
  assert.equal(await scopedText('name: mock # a note', 'comment'), '# a note');
});

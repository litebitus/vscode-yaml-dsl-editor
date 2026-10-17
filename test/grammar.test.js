const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const textmate = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const grammarPaths = {
  'source.yaml.dsl': path.join(__dirname, '..', 'syntaxes', 'yaml-dsl.tmLanguage.json'),
  'source.yaml.dsl.signature': path.join(__dirname, '..', 'syntaxes', 'yaml-dsl-signature.tmLanguage.json'),
};

async function loadRegistry() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  return new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (text) => new oniguruma.OnigString(text),
    }),
    loadGrammar: async (scopeName) => {
      const grammarPath = grammarPaths[scopeName];
      return textmate.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath);
    },
  });
}

const registryLoading = loadRegistry();

async function scopedText(line, scopeName, grammarScope = 'source.yaml.dsl') {
  const grammar = await (await registryLoading).loadGrammar(grammarScope);
  return grammar.tokenizeLine(line, textmate.INITIAL).tokens
    .filter((token) => token.scopes.some((scope) => scope.startsWith(scopeName)))
    .map((token) => line.slice(token.startIndex, token.endIndex))
    .join('');
}

const signatureScoped = (line, scopeName) => scopedText(line, scopeName, 'source.yaml.dsl.signature');

test('a signature colors the macro keyword, the name, each argument, its type and the return type apart', async () => {
  const macro = 'macro ForEach(identifier: text, collection: list, fragment: map)';
  assert.equal(await signatureScoped(macro, 'keyword.other.macro'), 'macro');
  assert.equal(await signatureScoped(macro, 'entity.name.function'), 'ForEach');
  assert.equal(await signatureScoped(macro, 'variable.parameter'), 'identifiercollectionfragment');
  assert.equal(await signatureScoped(macro, 'support.type'), 'textlistmap');
  const fn = 'format(layout: text, ...operands?: any): text';
  assert.equal(await signatureScoped(fn, 'keyword.other.macro'), '');
  assert.equal(await signatureScoped(fn, 'entity.name.function'), 'format');
  assert.equal(await signatureScoped(fn, 'variable.parameter'), 'layoutoperands');
  assert.equal(await signatureScoped(fn, 'keyword.operator'), '...?');
  assert.equal(await signatureScoped(fn, 'support.type.return'), 'text');
  assert.equal(await signatureScoped('macro AWS::Include(Location: text)', 'entity.name.function'), 'AWS::Include');
});

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

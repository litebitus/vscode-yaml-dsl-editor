const test = require('node:test');
const assert = require('node:assert/strict');
const { templateFor, fillTemplate } = require('../lib/reference-template');

const refRule = {
  pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_${}]+)',
  where: 'whole',
  target: { kind: 'resource', type: 'type', name: 'name' },
};
const localRule = { pattern: '^local\\.(?<name>[a-z0-9_]+)$', where: 'whole', target: { kind: 'local', name: 'name' } };
const placeholderRule = {
  pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}',
  where: 'within',
  target: { kind: 'local', name: 'name' },
};

test('a reference rule becomes a template that writes each symbol as the rule reads it', () => {
  const resource = { kind: 'resource', name: 'mock_thing', qualifiers: { type: 'mocktype' } };
  const perEnv = { kind: 'resource', name: '${env}_mock_thing', qualifiers: { type: 'mocktype' } };
  const local = { kind: 'local', name: 'mock_value', qualifiers: {} };
  assert.equal(templateFor(refRule).leadingText, 'ref ');
  assert.equal(fillTemplate(templateFor(refRule), resource), 'ref mocktype.mock_thing');
  assert.equal(fillTemplate(templateFor(refRule), perEnv), 'ref mocktype.${env}_mock_thing');
  assert.equal(fillTemplate(templateFor(refRule), local), null);
  assert.equal(fillTemplate(templateFor(localRule), local), 'local.mock_value');
  assert.equal(fillTemplate(templateFor(placeholderRule), local), '${local.mock_value}');
  assert.equal(fillTemplate(templateFor(localRule), { kind: 'local', name: 'Mock-Value' }), null);
  assert.equal(fillTemplate(templateFor(refRule), { kind: 'resource', name: 'mock_thing', qualifiers: {} }), null);
  assert.equal(fillTemplate(templateFor(placeholderRule), { kind: 'local', name: 'mock_value}x' }), null);
});

test('a pattern that is not a literal with named groups yields no template', () => {
  const target = { kind: 'local', name: 'name' };
  assert.equal(templateFor({ pattern: '^lo+cal\\.(?<name>[a-z]+)', target }), null);
  assert.equal(templateFor({ pattern: '^local\\d(?<name>[a-z]+)', target }), null);
  assert.equal(templateFor({ pattern: '^local\\.(?<other>[a-z]+)', target }), null);
  assert.equal(templateFor({ pattern: '(?<name>[a-z]+)\\.local', target }), null);
  assert.equal(templateFor({ pattern: '^local\\.(?<name>[a-z]+', target }), null);
  assert.equal(templateFor({ pattern: '^local\\', target }), null);
  assert.equal(templateFor({ target }), null);
  assert.deepEqual(templateFor({ pattern: '^local\\.(?<name>[(a-z)]+)\\$', target }).pieces, [
    { literalText: 'local.' },
    { group: 'name' },
    { literalText: '$' },
  ]);
});

test('a filled reference must read back as the symbol it was written for', () => {
  const aliased = { kind: 'resource', name: '${local.mock_alias}', qualifiers: { type: 'mocktype' } };
  assert.equal(fillTemplate(templateFor(refRule), aliased), null);
});

test('a rule\'s leading literal is the text before its first piece of regex syntax', () => {
  const { leadingLiteral } = require('../lib/reference-template');
  assert.equal(leadingLiteral(refRule), 'ref ');
  assert.equal(leadingLiteral({ pattern: '^ref [a-z.]+' }), 'ref ');
  assert.equal(leadingLiteral(placeholderRule), '${local.');
  assert.equal(leadingLiteral({ pattern: '^refs?' }), 'ref');
  assert.equal(leadingLiteral({ pattern: '\\d+' }), '');
  assert.equal(leadingLiteral({}), '');
});

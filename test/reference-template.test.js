const test = require('node:test');
const assert = require('node:assert/strict');
const { templateFor, fillTemplate } = require('../lib/reference-template');

const refRule = {
  pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_${}]+)',
  where: ['whole'],
  target: { scope: { group: 'type' }, name: 'name' },
};
const localRule = {
  pattern: '^local\\.(?<name>[a-z0-9_]+)$',
  where: ['whole'],
  target: { scope: { literal: 'local' }, name: 'name' },
};
const placeholderRule = {
  pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}',
  where: ['within'],
  target: { scope: { literal: 'local' }, name: 'name' },
};

test('a reference rule becomes a template that writes each symbol as the rule reads it', () => {
  const resource = { scope: 'mocktype', scopeFromParent: true, name: 'mock_thing' };
  const perEnv = { scope: 'mocktype', scopeFromParent: true, name: '${env}_mock_thing' };
  const local = { scope: 'local', scopeFromParent: false, name: 'mock_value' };
  assert.equal(templateFor(refRule).leadingText, 'ref ');
  assert.equal(fillTemplate(templateFor(refRule), resource), 'ref mocktype.mock_thing');
  assert.equal(fillTemplate(templateFor(refRule), perEnv), 'ref mocktype.${env}_mock_thing');
  assert.equal(fillTemplate(templateFor(refRule), local), null);
  assert.equal(fillTemplate(templateFor(localRule), local), 'local.mock_value');
  assert.equal(fillTemplate(templateFor(placeholderRule), local), '${local.mock_value}');
  assert.equal(fillTemplate(templateFor(localRule), { scope: 'local', name: 'Mock-Value' }), null);
  assert.equal(fillTemplate(templateFor(refRule), { scope: '', scopeFromParent: true, name: 'mock_thing' }), null);
  assert.equal(fillTemplate(templateFor(placeholderRule), { scope: 'local', name: 'mock_value}x' }), null);
  assert.equal(templateFor({ ...localRule, pattern: '^(?<name>[a-z]+)$' }), null);
  const bareRule = { ...localRule, pattern: '^(?<name>[a-z]+)$' };
  assert.equal(templateFor(bareRule, { leadingTextRequired: false }).leadingText, '');
});

test('a pattern that is not a literal with named groups yields no template', () => {
  const target = { scope: { literal: 'local' }, name: 'name' };
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
  const aliased = { scope: 'mocktype', scopeFromParent: true, name: '${local.mock_alias}' };
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

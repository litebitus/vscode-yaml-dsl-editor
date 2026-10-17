const test = require('node:test');
const assert = require('node:assert/strict');
const {
  templateFor,
  templatesFor,
  fillTemplate,
  leadingLiteral,
  placeholderShapesOf,
  wrapInPlaceholder,
} = require('../lib/reference-template');

const refRule = {
  pattern: '^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_${}]+)',
  positions: ['whole_scalar'],
  scopeName: 'ENTRY',
  scopeGroup: 'type',
  nameGroup: 'name',
};
const localRule = {
  pattern: '^local\\.(?<name>[a-z0-9_]+)$',
  positions: ['whole_scalar'],
  scopeName: 'local',
  scopeGroup: null,
  nameGroup: 'name',
};
const placeholderRule = {
  pattern: '\\$\\{local\\.(?<name>[a-z0-9_]+)\\}',
  positions: ['anywhere_in_scalar'],
  scopeName: 'local',
  scopeGroup: null,
  nameGroup: 'name',
};

const entrySymbol = (name) => ({ scope: 'mocktype', scopeName: 'ENTRY', name });
const localSymbol = (name) => ({ scope: 'local', scopeName: 'local', name });

test('a reference rule becomes a template that writes each symbol as the rule reads it', () => {
  assert.equal(templateFor(refRule).leadingText, 'ref ');
  assert.equal(fillTemplate(templateFor(refRule), entrySymbol('mock_thing')), 'ref mocktype.mock_thing');
  assert.equal(fillTemplate(templateFor(refRule), entrySymbol('${env}_mock_thing')), 'ref mocktype.${env}_mock_thing');
  assert.equal(fillTemplate(templateFor(refRule), localSymbol('mock_value')), null);
  assert.equal(fillTemplate(templateFor(localRule), localSymbol('mock_value')), 'local.mock_value');
  assert.equal(fillTemplate(templateFor(placeholderRule), localSymbol('mock_value')), '${local.mock_value}');
  assert.equal(fillTemplate(templateFor(localRule), localSymbol('Mock-Value')), null);
  assert.equal(fillTemplate(templateFor(localRule), { scope: 'other', scopeName: 'local', name: 'mock' }), null);
  assert.equal(fillTemplate(templateFor(refRule), { scope: '', scopeName: 'ENTRY', name: 'mock_thing' }), null);
  assert.equal(fillTemplate(templateFor(placeholderRule), localSymbol('mock_value}x')), null);
  assert.equal(templateFor({ ...localRule, pattern: '^(?<name>[a-z]+)$' }), null);
  const bareRule = { ...localRule, pattern: '^(?<name>[a-z]+)$' };
  assert.equal(templateFor(bareRule, { leadingTextRequired: false }).leadingText, '');
});

test('a character class of listed characters or ranges yields one template per member', () => {
  const shapes = placeholderShapesOf({ pattern: '[$&]\\{(?<body>[^}]+)\\}' });
  assert.deepEqual(shapes.map((shape) => wrapInPlaceholder(shape, 'MockName')), ['${MockName}', '&{MockName}']);
  const texts = (pattern) => templatesFor({ ...localRule, pattern }).map((template) => fillTemplate(template, localSymbol('m')));
  assert.deepEqual(texts('^[a-c\\-]\\.(?<name>[a-z]+)'), ['a.m', 'b.m', 'c.m', '-.m']);
  assert.deepEqual(texts('^[^a]\\.(?<name>[a-z]+)'), []);
  assert.deepEqual(texts('^[ab]+\\.(?<name>[a-z]+)'), []);
  assert.deepEqual(texts('^[\\d]\\.(?<name>[a-z]+)'), []);
  assert.deepEqual(texts('^[ab'), []);
});

test('a pattern that is not a literal with named groups yields no template', () => {
  const rule = (pattern) => ({ ...localRule, pattern });
  assert.equal(templateFor(rule('^lo+cal\\.(?<name>[a-z]+)')), null);
  assert.equal(templateFor(rule('^local\\d(?<name>[a-z]+)')), null);
  assert.equal(templateFor(rule('^local\\.(?<other>[a-z]+)')), null);
  assert.equal(templateFor(rule('(?<name>[a-z]+)\\.local')), null);
  assert.equal(templateFor(rule('^local\\.(?<name>[a-z]+')), null);
  assert.equal(templateFor(rule('^local\\')), null);
  assert.equal(templateFor({ ...localRule, pattern: undefined }), null);
  assert.deepEqual(templateFor(rule('^local\\.(?<name>[(a-z)]+)\\$')).pieces, [
    { literalText: 'local.' },
    { group: 'name' },
    { literalText: '$' },
  ]);
});

test('a filled reference must read back as the symbol it was written for', () => {
  assert.equal(fillTemplate(templateFor(refRule), entrySymbol('${local.mock_alias}')), null);
});

test('a rule\'s leading literal is the text before its first piece of regex syntax', () => {
  assert.equal(leadingLiteral(refRule), 'ref ');
  assert.equal(leadingLiteral({ pattern: '^ref [a-z.]+' }), 'ref ');
  assert.equal(leadingLiteral(placeholderRule), '${local.');
  assert.equal(leadingLiteral({ pattern: '^refs?' }), 'ref');
  assert.equal(leadingLiteral({ pattern: '\\d+' }), '');
  assert.equal(leadingLiteral({}), '');
});

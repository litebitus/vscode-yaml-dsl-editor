const test = require('node:test');
const assert = require('node:assert/strict');
const { validationDocumentOf } = require('../lib/validation-document');

const rules = {
  mergeBaseKeys: ['defaults'],
  childValuesFromParentKey: [{ pattern: '^(?<field>[a-z][a-z0-9_]*) (?<value>[a-z0-9]+(-[a-z0-9]+)*)$' }],
};

test('a key matching a child value pattern sets that field of its entry, unless the entry sets it', () => {
  const written = {
    mocktype: {
      'name mock-primary': { size: 1 },
      'name mock-other': { name: 'mock-written' },
      'labels fn.merge*': { size: 2 },
    },
  };
  assert.deepEqual(validationDocumentOf(written, rules).value, {
    mocktype: {
      'name mock-primary': { size: 1, name: 'mock-primary' },
      'name mock-other': { name: 'mock-written' },
      'labels fn.merge*': { size: 2 },
    },
  });
});

test('a merge base key is merged under each sibling entry, the sibling\'s own fields winning, at any depth', () => {
  const written = {
    mocktype: {
      defaults: { size: 1, settings: { depth: 2 } },
      primary: { size: 3 },
      other: { settings: { width: 4 } },
      scalar: 'mock-scalar',
    },
    nested: { inner: { defaults: { mode: 'fast' }, item: {} } },
  };
  assert.deepEqual(validationDocumentOf(written, rules).value, {
    mocktype: {
      defaults: { size: 1, settings: { depth: 2 } },
      primary: { size: 3, settings: { depth: 2 } },
      other: { size: 1, settings: { depth: 2, width: 4 } },
      scalar: 'mock-scalar',
    },
    nested: { inner: { defaults: { mode: 'fast' }, item: { mode: 'fast' } } },
  });
});

test('nothing under a merge base is required, and an error a merge base copied into a sibling is reported once, at the base', () => {
  const written = { mocktype: { defaults: { size: 'mock-wrong' }, primary: { mode: 'fast' } } };
  const document = validationDocumentOf(written, rules);
  assert.equal(document.reports({ keyword: 'required', path: ['mocktype', 'defaults'] }), false);
  assert.equal(document.reports({ keyword: 'required', path: ['mocktype', 'primary'] }), true);
  assert.equal(document.reports({ keyword: 'type', path: ['mocktype', 'defaults', 'size'] }), true);
  assert.equal(document.reports({ keyword: 'type', path: ['mocktype', 'primary', 'size'] }), false);
  assert.equal(document.reports({ keyword: 'type', path: ['mocktype', 'primary', 'mode'] }), true);
});

test('a DSL without validator rules is validated as written', () => {
  const written = { mocktype: { defaults: { size: 1 }, 'name mock-primary': {} } };
  const document = validationDocumentOf(written, null);
  assert.equal(document.value, written);
  assert.equal(document.reports({ keyword: 'required', path: ['mocktype', 'defaults'] }), true);
});

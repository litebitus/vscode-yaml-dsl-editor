const test = require('node:test');
const assert = require('node:assert/strict');
const { validationDocumentOf } = require('../lib/validation-document');

const dsl = {
  validator: {
    mergeBaseKeys: ['defaults'],
    childValuesFromParentKey: [{ pattern: '^(?<field>[a-z][a-z0-9_]*) (?<value>[a-z0-9]+(-[a-z0-9]+)*)$' }],
  },
  function: { markerFunction: { callMarker: 'fn.', splatOperator: '*', callsWithoutNameAllowed: true } },
};

test('a key matching a child value pattern sets that field of its entry, unless the entry sets it', () => {
  const written = {
    mocktype: {
      'name mock-primary': { size: 1 },
      'name mock-other': { name: 'mock-written' },
      'labels fn.merge*': { size: 2 },
    },
  };
  assert.deepEqual(validationDocumentOf(written, dsl).value, {
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
  assert.deepEqual(validationDocumentOf(written, dsl).value, {
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
  const document = validationDocumentOf(written, dsl);
  assert.equal(document.reports({ keyword: 'required', path: ['mocktype', 'defaults'] }), false);
  assert.equal(document.reports({ keyword: 'required', path: ['mocktype', 'primary'] }), true);
  assert.equal(document.reports({ keyword: 'type', path: ['mocktype', 'defaults', 'size'] }), true);
  assert.equal(document.reports({ keyword: 'type', path: ['mocktype', 'primary', 'size'] }), false);
  assert.equal(document.reports({ keyword: 'type', path: ['mocktype', 'primary', 'mode'] }), true);
});

test('a field a call key of the marker function supplies is not reported missing', () => {
  const written = { mocktype: { doors: { 'value fn.jsonencode': { mock: 1 } }, other: { 'fn.merge*': [] } } };
  const document = validationDocumentOf(written, dsl);
  const missing = (path, requiredField) => ({ keyword: 'required', path, requiredField });
  assert.equal(document.reports(missing(['mocktype', 'doors'], 'value')), false);
  assert.equal(document.reports(missing(['mocktype', 'doors'], 'path')), true);
  assert.equal(document.reports(missing(['mocktype', 'other'], 'value')), true);
  assert.equal(document.reports(missing(['mocktype', 'absent'], 'value')), true);
  const withoutCalls = validationDocumentOf(written, { ...dsl, function: null });
  assert.equal(withoutCalls.reports(missing(['mocktype', 'doors'], 'value')), true);
});

test('a DSL without validator rules is validated as written', () => {
  const written = { mocktype: { defaults: { size: 1 }, 'name mock-primary': {} } };
  const document = validationDocumentOf(written, { validator: null, function: null });
  assert.deepEqual(document.value, written);
  assert.equal(document.reports({ keyword: 'required', path: ['mocktype', 'defaults'] }), true);
});

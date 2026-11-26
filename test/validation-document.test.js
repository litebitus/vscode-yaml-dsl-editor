const test = require('node:test');
const assert = require('node:assert/strict');
const { validationDocumentOf, validatorBlockOf } = require('../lib/validation-document');
const { resolvedDocumentProblemsOf, problemTextsOf } = require('./validation-builders');
const { parsedDsl, dslEntry, placeholder, scope, declaration, reference } = require('./config-builders');

const dsl = {
  validator: {
    mergeBaseKeys: ['defaults'],
    childValuesFromParentKey: [{ pattern: '^(?<field>[a-z][a-z0-9_]*) (?<value>[a-z0-9]+(-[a-z0-9]+)*)$' }],
  },
  function: { markerFunction: { callMarker: 'fn.', splatOperator: '*', callsWithoutNameAllowed: true } },
};

const entriesSchemaOf = (entrySchema) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: { mocktype: { type: 'object', additionalProperties: entrySchema } },
});

function sourceProblemsOf(entrySchema, written, documentDsl = dsl) {
  const document = validationDocumentOf(written, documentDsl);
  const problems = resolvedDocumentProblemsOf(entriesSchemaOf(entrySchema), document.resolvedDocument(), {
    validator: validatorBlockOf(documentDsl),
  });
  return problemTextsOf(document.sourceProblemsOf(problems));
}

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
  const entrySchema = {
    type: 'object',
    required: ['label'],
    properties: { label: { type: 'string' }, size: { type: 'integer' }, mode: { type: 'string' } },
  };
  assert.deepEqual(sourceProblemsOf(entrySchema, written), [
    [['mocktype', 'defaults', 'size'], '`size` must be `integer`'],
    [['mocktype', 'primary'], '`label` is required'],
  ]);
});

test('a field a call key of the marker function supplies is not reported missing', () => {
  const written = { mocktype: { doors: { 'value fn.jsonencode': { mock: 1 } }, other: { 'fn.merge*': [] } } };
  const entrySchema = {
    type: 'object',
    required: ['value', 'path'],
    properties: { value: { type: 'string' }, path: { type: 'string' } },
  };
  assert.deepEqual(sourceProblemsOf(entrySchema, written), [
    [['mocktype', 'doors'], '`path` is required'],
  ]);
  assert.deepEqual(sourceProblemsOf(entrySchema, written, { ...dsl, function: null }), [
    [['mocktype', 'doors'], '`path` is required'],
    [['mocktype', 'doors'], '`value` is required'],
    [['mocktype', 'other'], '`path` is required'],
    [['mocktype', 'other'], '`value` is required'],
  ]);
});

test('a call key naming a field stands for that field alone, its problems placed on the key as written', () => {
  const written = { mocktype: { doors: { 'value fn.jsonencode': { mock: 1 } }, gates: { 'mode fn.lower': 'X' } } };
  const entrySchema = {
    type: 'object',
    maxProperties: 1,
    additionalProperties: false,
    properties: { value: { type: 'string' }, mode: { enum: ['fast'] } },
    required: ['value'],
  };
  assert.deepEqual(sourceProblemsOf(entrySchema, written), [
    [['mocktype', 'gates'], '`value` is required'],
  ]);
  const closedSchema = { type: 'object', additionalProperties: false, properties: { size: { type: 'integer' } } };
  assert.deepEqual(sourceProblemsOf(closedSchema, { mocktype: { doors: { 'value fn.jsonencode': {} } } }), [
    [['mocktype', 'doors', 'value fn.jsonencode'], '`value` is not defined in the schema'],
  ]);
});

test('a value a call without a name or a reference computes is not checked against its type', () => {
  const written = {
    mocktype: {
      primary: {
        command: [
          '/mock-app',
          { 'fn.format*': ['--mock-list=%s', { 'fn.join*': [',', ['mock-a', 'mock-b']] }] },
          { mock: 'mock-value' },
        ],
        ports: 'ref mocktype.other.ports',
        size: 'mock-size',
      },
    },
  };
  const entrySchema = {
    type: 'object',
    properties: {
      command: { type: 'array', items: { type: 'string' } },
      ports: { type: 'array' },
      size: { type: 'integer' },
    },
  };
  const referencingDsl = {
    ...dsl,
    references: [{ pattern: '^ref (?<type>[a-z]+)\\.(?<name>[a-z]+)', positions: ['whole_scalar'] }],
  };
  assert.deepEqual(sourceProblemsOf(entrySchema, written, referencingDsl), [
    [['mocktype', 'primary', 'command', 2], '`command[2]` must be `string`'],
    [['mocktype', 'primary', 'size'], '`size` must be `integer`'],
  ]);
});

test('an alternative is not reported when every field of one of its missing sets is supplied', () => {
  const written = { mocktype: { doors: { cors: { 'origins fn.formatlist*': [] } } } };
  const entrySchemaWith = (alternatives) => ({
    type: 'object',
    properties: { cors: { type: 'object' } },
    ...alternatives,
  });
  const corsRequiring = (...fields) => ({ properties: { cors: { required: fields } } });
  assert.deepEqual(sourceProblemsOf(entrySchemaWith({
    oneOf: [corsRequiring('methods'), corsRequiring('origins')],
  }), written), []);
  assert.deepEqual(sourceProblemsOf(entrySchemaWith({ anyOf: [corsRequiring('origins', 'methods')] }), written), [
    [['mocktype', 'doors'], '`doors` matches none of its allowed forms'],
  ]);
});

test('a DSL without validator rules is validated as written', () => {
  const written = { mocktype: { defaults: { size: 1 }, 'name mock-primary': {} } };
  const withoutRules = { validator: null, function: null };
  assert.deepEqual(validationDocumentOf(written, withoutRules).value, written);
  const entrySchema = { type: 'object', required: ['label'], properties: { label: { type: 'string' } } };
  assert.deepEqual(sourceProblemsOf(entrySchema, written, withoutRules), [
    [['mocktype', 'defaults'], '`label` is required'],
    [['mocktype', 'name mock-primary'], '`label` is required'],
  ]);
});

const keyedDsl = parsedDsl(dslEntry('mock-keyed', {
  placeholder: placeholder(),
  locals: { scope_name: 'local', path_separator: '.' },
  scopes: {
    GLOBAL: scope({ builtin_names: ['env'] }),
    local: scope(),
    ENTRY: scope({ named_by_parent_key: true }),
  },
  declarations: [declaration('$.locals.*', 'local')],
  references: [
    reference('^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_]+)', 'ENTRY', {
      text_after_name_allowed: true,
      scope_group: 'type',
    }),
    reference('^local\\.(?<name>[a-z0-9_]+)(?=$|\\.)', 'local', {
      positions: ['whole_scalar', 'whole_placeholder', 'placeholder_in_text'],
      text_after_name_allowed: true,
    }),
    reference('^(?<name>[a-z_]+)$', 'GLOBAL', { positions: ['whole_placeholder', 'placeholder_in_text'] }),
  ],
}));

test('a key that is a whole reference, or holds a placeholder whose value is not a constant, '
  + 'is a deferred key', () => {
  const written = {
    locals: {
      mock_id: 'mock',
      mock_names: { api: '${local.mock_id}-api' },
      mock_target: 'ref mocktype.mock_primary',
      mock_looped: '${local.mock_looped}',
      mock_map: { size: 1 },
    },
    mocktype: {
      mock_primary: {},
      'ref mocktype.mock_primary': {},
      '${local.mock_id}-socket': {},
      '${local.mock_names.api}-v2': {},
      '${env}-queue': {},
      '${local.mock_target}-topic': {},
      '${local.mock_looped}-bucket': {},
      '${local.mock_map}-table': {},
      '${unread}-stream': {},
      '${GLOBAL}-key': {},
    },
  };
  const localPaths = new Map(Object.keys(written.locals).map((name) => [name, ['locals', name]]));
  const document = validationDocumentOf(written, keyedDsl, null, localPaths).resolvedDocument();
  const mocktype = document.value.find((entry) => entry.key === 'mocktype').value;
  assert.deepEqual(mocktype.value.map((entry) => [entry.key, entry.deferredKey && entry.deferredKey.kind]), [
    ['mock_primary', null],
    ['ref mocktype.mock_primary', 'reference'],
    ['${local.mock_id}-socket', null],
    ['${local.mock_names.api}-v2', null],
    ['${env}-queue', null],
    ['${local.mock_target}-topic', 'template'],
    ['${local.mock_looped}-bucket', 'template'],
    ['${local.mock_map}-table', 'template'],
    ['${unread}-stream', 'template'],
    ['${GLOBAL}-key', 'template'],
  ]);
});

test('a deferred key reports no problem its name decides, while its siblings\' problems stand', () => {
  const entrySchema = {
    type: 'object',
    required: ['size'],
    properties: { size: { type: 'integer' } },
    additionalProperties: false,
  };
  const written = {
    mocktype: {
      'ref mocktype.mock_primary': { size: 'mock-one' },
      mock_other: { size: 'mock-one' },
    },
  };
  assert.deepEqual(sourceProblemsOf(entrySchema, written, keyedDsl), [
    [['mocktype', 'mock_other', 'size'], '`size` must be `integer`'],
  ]);
});

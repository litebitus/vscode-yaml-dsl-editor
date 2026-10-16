const vm = require('vm');
const { createRequire } = require('module');
const { _Code } = require('ajv/dist/compile/codegen/code');
const standaloneCode = require('ajv/dist/standalone').default;
const { schemaNodePointersOf, schemaNodeAt } = require('./schema-pointers');

const SCHEMA_VALUE_PREFIX = 'schema';
const SCHEMA_NODE_FUNCTION = 'schemaNode';
const ajvRuntimeRequire = createRequire(require.resolve('ajv'));

function standaloneRootSource(ajv, validate, root) {
  const pointers = schemaNodePointersOf(root);
  const schemaValues = ajv.scope._values[SCHEMA_VALUE_PREFIX] || new Map();
  for (const name of schemaValues.values()) {
    const pointer = name.value ? pointers.get(name.value.ref) : undefined;
    if (pointer !== undefined) name.value.code = new _Code(`${SCHEMA_NODE_FUNCTION}(${JSON.stringify(pointer)})`);
  }
  return standaloneCode(ajv, validate);
}

function loadedRootValidate(source, root, filename) {
  const parameters = ['exports', 'require', 'module', SCHEMA_NODE_FUNCTION];
  const loadModule = vm.compileFunction(source, parameters, { filename });
  const loaded = { exports: {} };
  loadModule(loaded.exports, ajvRuntimeRequire, loaded, (pointer) => schemaNodeAt(root, pointer));
  if (typeof loaded.exports !== 'function') throw new Error(`${filename} holds no validator`);
  return loaded.exports;
}

module.exports = { standaloneRootSource, loadedRootValidate };

const path = require('path');
const { schemaResolution } = require('yaml-dsl-spec');
const { isSchemaUrl } = require('../lib/schema');
const { createWorkspace } = require('../lib/workspace');

const CONFIG_ROOT = '{config_root}';
const NO_SCHEMA_FOUND = 'no schema found';

function virtualDocumentSchemasOf(readFile, fetchText = async () => null) {
  const readOrNull = async (read, location) => {
    try {
      return await read(location);
    } catch {
      return null;
    }
  };

  function schemaPathOf(filePath, written, configFolder) {
    if (written.startsWith(CONFIG_ROOT)) return path.join(configFolder, written.slice(CONFIG_ROOT.length));
    return path.resolve(path.dirname(filePath), written);
  }

  async function documentSchemaOf(filePath, text, searchPathTexts, configFolder) {
    const modeline = schemaResolution.documentModeline(text);
    const namedLocations = searchPathTexts.map((written) => ({ written, fragmentPointer: null }));
    if (modeline) {
      const [written] = modeline.schemaUri.split('#');
      namedLocations.unshift({ written, fragmentPointer: modeline.schemaFragment });
    }
    const watchedPaths = [];
    for (const { written, fragmentPointer } of namedLocations) {
      const schemaPath = isSchemaUrl(written) ? null : schemaPathOf(filePath, written, configFolder);
      if (schemaPath) watchedPaths.push(schemaPath);
      const schemaText = schemaPath ? await readOrNull(readFile, schemaPath) : await readOrNull(fetchText, written);
      if (schemaText === null || schemaText === undefined) continue;
      const schemaName = schemaPath ? path.basename(schemaPath) : written;
      return { schemaText, schemaName, fragmentPointer, watchedPaths, error: null, modelineWarnings: [] };
    }
    return {
      schemaText: null,
      schemaName: null,
      fragmentPointer: null,
      watchedPaths,
      error: NO_SCHEMA_FOUND,
      modelineWarnings: [],
    };
  }

  return { documentSchemaOf, setStorageFolder: () => {}, setStoreCapacity: () => {} };
}

function createVirtualWorkspace({ fetchText, ...workspaceOptions }) {
  return createWorkspace({
    ...workspaceOptions,
    documentSchemas: virtualDocumentSchemasOf(workspaceOptions.readFile, fetchText),
  });
}

module.exports = { virtualDocumentSchemasOf, createVirtualWorkspace, NO_SCHEMA_FOUND };

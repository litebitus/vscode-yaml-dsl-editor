const path = require('path');
const { parseConfig, claimFile } = require('./config');
const { discoverStack, environmentOf } = require('./discover');
const { createCache } = require('./cache');
const { analyzeDocument, hoverAt, definitionAt, linksFor } = require('./analyze');
const { foldDocument } = require('./fold');
const { readModeline, parseSchema } = require('./schema');
const { zeroRange } = require('./range');

const SCHEMA_UNAVAILABLE = 'schema is unavailable';

function parseFoldUri(uri) {
  const prefix = 'yaml-dsl-fold:';
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return null;
  return {
    stackId: decodeURIComponent(rest.slice(0, slash)),
    env: decodeURIComponent(rest.slice(slash + 1)),
  };
}

function createWorkspace({ readFile, fetchText }) {
  const cache = createCache();
  let dsls = [];
  let configErrors = [];
  const docs = new Map();
  const claims = new Map();
  let activePath = null;
  const visible = new Set();

  async function readAndParse(spec, baseDir) {
    let body;
    try {
      body = /^https?:\/\//.test(spec) ? await fetchText(spec) : await readFile(path.resolve(baseDir, spec));
    } catch {
      return null;
    }
    if (body == null) return null;
    const object = parseSchema(body);
    if (!object) return null;
    return { text: body, object };
  }

  async function loadSchemaFor(filePath, text, dsl) {
    const fileDir = path.dirname(filePath);
    const candidates = [];
    const modeline = readModeline(text);
    if (modeline) candidates.push(modeline);
    for (const spec of dsl.schema || []) candidates.push(spec);
    for (const spec of candidates) {
      const parsed = await readAndParse(spec, fileDir);
      if (parsed) return { hash: cache.noteSchema(parsed.text, parsed.object), error: null };
    }
    return { hash: null, error: SCHEMA_UNAVAILABLE };
  }

  async function textOf(filePath) {
    for (const doc of docs.values()) {
      if (doc.scheme === 'file' && doc.path === filePath) return doc.text;
    }
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  function findEntry(filePath) {
    return cache.find((entry) => entry.data.paths.includes(filePath));
  }

  function flagsFor(stackId) {
    return { pinned: stackId === activeStackId(), onScreen: visible.has(stackId) };
  }

  function activeStackId() {
    if (!activePath) return null;
    const entry = findEntry(activePath);
    return entry ? entry.id : null;
  }

  async function build(filePath, dsl) {
    if (!dsl.layers) {
      const text = await textOf(filePath);
      const source = text == null ? '' : text;
      const doc = analyzeDocument(source, filePath, dsl);
      const schema = text == null
        ? { hash: null, error: SCHEMA_UNAVAILABLE }
        : await loadSchemaFor(filePath, source, dsl);
      return cache.hold(filePath, {
        id: filePath,
        common: filePath,
        overlays: {},
        environments: [],
        layers: false,
        dsl,
        paths: [filePath],
        files: new Map([[filePath, doc]]),
        symbols: doc.symbols,
        schemas: new Map([[filePath, schema]]),
      }, flagsFor(filePath));
    }
    const stack = discoverStack(filePath, dsl.layers.environments);
    const paths = [stack.common, ...dsl.layers.environments.map((env) => stack.overlays[env])];
    const files = new Map();
    const schemas = new Map();
    const symbols = [];
    for (const layerPath of paths) {
      const text = await textOf(layerPath);
      if (text == null) continue;
      const doc = analyzeDocument(text, layerPath, dsl);
      files.set(layerPath, doc);
      symbols.push(...doc.symbols);
      schemas.set(layerPath, await loadSchemaFor(layerPath, text, dsl));
    }
    return cache.hold(stack.id, {
      id: stack.id,
      common: stack.common,
      overlays: stack.overlays,
      environments: stack.environments,
      layers: true,
      dsl,
      paths,
      files,
      symbols,
      schemas,
    }, flagsFor(stack.id));
  }

  function refreshPins() {
    const activeId = activeStackId();
    for (const entry of cache.entries()) {
      cache.setFlags(entry.id, { pinned: entry.id === activeId, onScreen: visible.has(entry.id) });
    }
    cache.rebalance();
  }

  async function setConfigs(entries) {
    dsls = [];
    configErrors = [];
    for (const entry of entries) {
      const parsed = parseConfig(entry.text);
      if (!parsed.ok) configErrors.push(parsed.error);
      for (const dsl of parsed.dsls) dsls.push({ ...dsl, dir: entry.dir });
    }
    for (const doc of docs.values()) {
      if (doc.scheme !== 'file') continue;
      const claim = claimFile(doc.path, dsls);
      claims.set(doc.path, claim);
      if (claim.status === 'one') await build(doc.path, claim.dsl);
    }
    refreshPins();
  }

  async function sync(uri, filePath, text) {
    if (parseFoldUri(uri)) {
      docs.set(uri, { uri, path: filePath, text, scheme: 'fold' });
      return;
    }
    docs.set(uri, { uri, path: filePath, text, scheme: 'file' });
    const claim = claimFile(filePath, dsls);
    claims.set(filePath, claim);
    if (claim.status !== 'one') return;
    await build(filePath, claim.dsl);
    refreshPins();
  }

  function close(uri) {
    docs.delete(uri);
  }

  async function setActive(filePath) {
    activePath = filePath || null;
    if (!activePath) {
      refreshPins();
      return;
    }
    const claim = claimFile(activePath, dsls);
    claims.set(activePath, claim);
    if (claim.status !== 'one') {
      refreshPins();
      return;
    }
    const existing = findEntry(activePath);
    if (existing) cache.touch(existing.id);
    else await build(activePath, claim.dsl);
    refreshPins();
  }

  function setVisibleFolds(stackIds) {
    visible.clear();
    for (const id of stackIds || []) visible.add(id);
    refreshPins();
    for (const id of visible) cache.touch(id);
  }

  function openUris() {
    return [...docs.values()].filter((doc) => doc.scheme === 'file').map((doc) => doc.uri);
  }

  function diagnostics(uri) {
    const doc = docs.get(uri);
    if (!doc || doc.scheme !== 'file') return [];
    if (path.basename(doc.path) === 'yaml-dsl.yml' && configErrors.length) {
      return configErrors.map((message) => ({ range: zeroRange(), message, severity: 1 }));
    }
    const claim = claims.get(doc.path) || { status: 'none' };
    if (claim.status === 'many') {
      return [{ range: zeroRange(), message: `claimed by ${claim.ids.join(' and ')}`, severity: 1 }];
    }
    if (claim.status !== 'one') return [];
    const entry = findEntry(doc.path);
    if (!entry) return [];
    const file = entry.data.files.get(doc.path);
    const diags = [];
    if (file) {
      for (const err of file.errors) diags.push({ range: err.range, message: err.message, severity: 1 });
    }
    const schema = entry.data.schemas.get(doc.path);
    if (schema && schema.error) diags.push({ range: zeroRange(), message: schema.error, severity: 1 });
    return diags;
  }

  function schemaFor(entry, filePath) {
    const schema = entry.data.schemas.get(filePath);
    if (!schema || !schema.hash) return null;
    return cache.schemaObject(schema.hash);
  }

  function stackOf(entry) {
    return {
      symbols: entry.data.symbols,
      common: entry.data.common,
      files: entry.data.files,
      root: entry.data.dsl && entry.data.dsl.dir,
    };
  }

  function render(data, env) {
    const commonFile = data.files.get(data.common);
    const overlayPath = data.overlays[env];
    const overlayFile = overlayPath ? data.files.get(overlayPath) : null;
    return foldDocument(
      env,
      commonFile ? commonFile.value : null,
      overlayFile ? overlayFile.value : null,
      Boolean(overlayFile),
    );
  }

  function hover(uri, position) {
    const fold = parseFoldUri(uri);
    if (fold) {
      const entry = cache.get(fold.stackId);
      if (!entry) return null;
      cache.touch(entry.id);
      const rendered = render(entry.data, fold.env);
      const prefer = entry.data.files.has(entry.data.overlays[fold.env])
        ? entry.data.overlays[fold.env]
        : entry.data.common;
      const doc = analyzeDocument(rendered.text, prefer, entry.data.dsl);
      return hoverAt(doc, position, stackOf(entry), schemaFor(entry, prefer));
    }
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return null;
    const entry = findEntry(docInfo.path);
    if (!entry) return null;
    cache.touch(entry.id);
    return hoverAt(entry.data.files.get(docInfo.path), position, stackOf(entry), schemaFor(entry, docInfo.path));
  }

  function definition(uri, position) {
    const fold = parseFoldUri(uri);
    if (fold) {
      const entry = cache.get(fold.stackId);
      if (!entry) return null;
      cache.touch(entry.id);
      const rendered = render(entry.data, fold.env);
      const prefer = entry.data.files.has(entry.data.overlays[fold.env])
        ? entry.data.overlays[fold.env]
        : entry.data.common;
      const doc = analyzeDocument(rendered.text, prefer, entry.data.dsl);
      return definitionAt(doc, position, stackOf(entry));
    }
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return null;
    const entry = findEntry(docInfo.path);
    if (!entry) return null;
    cache.touch(entry.id);
    return definitionAt(entry.data.files.get(docInfo.path), position, stackOf(entry));
  }

  function links(uri) {
    const fold = parseFoldUri(uri);
    if (fold) {
      const entry = cache.get(fold.stackId);
      if (!entry) return [];
      const rendered = render(entry.data, fold.env);
      const prefer = entry.data.files.has(entry.data.overlays[fold.env])
        ? entry.data.overlays[fold.env]
        : entry.data.common;
      const doc = analyzeDocument(rendered.text, prefer, entry.data.dsl);
      return linksFor(doc, stackOf(entry));
    }
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return [];
    const entry = findEntry(docInfo.path);
    if (!entry) return [];
    return linksFor(entry.data.files.get(docInfo.path), stackOf(entry));
  }

  function foldsFor(filePath) {
    const entry = findEntry(filePath);
    if (!entry || !entry.data.layers) return { stackId: null, environments: [] };
    const env = environmentOf(filePath, entry.data);
    if (env) return { stackId: entry.id, environments: [env] };
    return { stackId: entry.id, environments: entry.data.environments.slice() };
  }

  function foldText(stackId, env) {
    const entry = cache.get(stackId);
    if (!entry || !entry.data.layers) return '';
    return render(entry.data, env).text;
  }

  return {
    setConfigs,
    sync,
    close,
    setActive,
    setVisibleFolds,
    diagnostics,
    hover,
    definition,
    links,
    foldsFor,
    foldText,
    openUris,
    cache,
    takeEvicted: () => cache.takeEvicted(),
  };
}

module.exports = { createWorkspace, parseFoldUri, SCHEMA_UNAVAILABLE };

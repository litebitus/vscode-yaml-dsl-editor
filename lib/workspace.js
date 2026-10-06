const path = require('path');
const { parseConfig, claimFile } = require('./config');
const { discoverStack, environmentOf } = require('./discover');
const { createCache } = require('./cache');
const {
  analyzeDocument,
  hoverAt,
  definitionAt,
  linksFor,
  classifiedReferences,
  analysisProblems,
  completionAt,
  tokensFor,
  uriToPath,
} = require('./analyze');
const { terraformVocabulary, schemaVocabulary } = require('./function-calls');
const { foldDocument } = require('./fold');
const { readModeline, parseSchema } = require('./schema');
const { zeroRange } = require('./range');
const { createWorkQueue } = require('./work-queue');

const SCHEMA_UNAVAILABLE = 'schema is unavailable';
const WORK_PRIORITY = { active: 0, open: 1, background: 2 };

function escapeGlob(text) {
  return text.replace(/[*?[\]{}]/g, (character) => `[${character}]`);
}

function liesOutside(folderPath, filePath) {
  const relativePath = path.relative(folderPath, filePath);
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
}

function watchTargetsFor(readerDir, schemaPath) {
  let watchBase = readerDir;
  while (liesOutside(watchBase, schemaPath) && watchBase !== path.dirname(watchBase)) {
    watchBase = path.dirname(watchBase);
  }
  const patternSegments = path.relative(watchBase, schemaPath).split(path.sep).map(escapeGlob);
  return patternSegments.map((_, index) => ({
    base: watchBase,
    pattern: patternSegments.slice(0, index + 1).join('/'),
  }));
}

function changeCovers(changedPath, schemaPath) {
  return changedPath === schemaPath || schemaPath.startsWith(`${changedPath}${path.sep}`);
}

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

function createWorkspace({ readFile, fetchText, terraformFunctions = async () => null }) {
  const cache = createCache();
  let dsls = [];
  let configErrors = [];
  const docs = new Map();
  const claims = new Map();
  let activePath = null;
  const visible = new Set();
  const workQueue = createWorkQueue();
  let terraformLoad = null;
  let terraformTable = null;
  let vocabularyListener = null;
  const openedUris = new Set();

  function stackIdFor(filePath, dsl) {
    if (!dsl.layers) return filePath;
    return discoverStack(filePath, dsl.layers.environments).id;
  }

  function claimedStackId(filePath) {
    const claim = claimFile(filePath, dsls);
    return claim.status === 'one' ? stackIdFor(filePath, claim.dsl) : null;
  }

  function priorityOf(stackId) {
    if (activePath && claimedStackId(activePath) === stackId) return WORK_PRIORITY.active;
    for (const doc of docs.values()) {
      if (doc.scheme === 'file' && claimedStackId(doc.path) === stackId) return WORK_PRIORITY.open;
    }
    return WORK_PRIORITY.background;
  }

  function scheduleWork(stackId, work) {
    return workQueue.schedule(priorityOf(stackId), stackId, work);
  }

  function analyzed(filePath, text) {
    const existing = findEntry(filePath);
    const cached = existing && existing.data.files.get(filePath);
    return Boolean(cached && cached.text === text);
  }

  async function readSchemaText(spec, baseDir) {
    try {
      return /^https?:\/\//.test(spec) ? await fetchText(spec) : await readFile(path.resolve(baseDir, spec));
    } catch {
      return null;
    }
  }

  async function loadSchemaFor(filePath, text, dsl) {
    const fileDir = path.dirname(filePath);
    const candidates = [];
    const modeline = readModeline(text);
    if (modeline) candidates.push(modeline);
    for (const spec of dsl.schema || []) candidates.push(spec);
    const watchedPaths = [];
    for (const spec of candidates) {
      if (!/^https?:\/\//.test(spec)) watchedPaths.push(path.resolve(fileDir, spec));
      const schemaText = await readSchemaText(spec, fileDir);
      const schemaHash = schemaText == null ? null : cache.noteSchema(schemaText, parseSchema);
      if (schemaHash) return { hash: schemaHash, error: null, watchedPaths };
    }
    return { hash: null, error: SCHEMA_UNAVAILABLE, watchedPaths };
  }

  function schemaWatchTargets() {
    const targetsByKey = new Map();
    for (const entry of cache.entries()) {
      for (const [readerPath, schema] of entry.data.schemas) {
        for (const schemaPath of schema.watchedPaths || []) {
          for (const watchTarget of watchTargetsFor(path.dirname(readerPath), schemaPath)) {
            targetsByKey.set(`${watchTarget.base}\n${watchTarget.pattern}`, watchTarget);
          }
        }
      }
    }
    return [...targetsByKey.values()];
  }

  async function reloadSchemas(stackId, readerPaths) {
    const entry = cache.get(stackId);
    if (!entry) return;
    const schemas = new Map(entry.data.schemas);
    let anyReloaded = false;
    for (const readerPath of readerPaths) {
      const readerDoc = entry.data.files.get(readerPath);
      const previousSchema = schemas.get(readerPath);
      const reloadedSchema = await loadSchemaFor(readerPath, readerDoc ? readerDoc.text : '', entry.data.dsl);
      if (reloadedSchema.hash === previousSchema.hash && reloadedSchema.error === previousSchema.error) continue;
      schemas.set(readerPath, reloadedSchema);
      anyReloaded = true;
    }
    if (anyReloaded) cache.replaceData(stackId, { ...entry.data, schemas });
  }

  async function schemasChanged(paths) {
    const changedPaths = paths || [];
    const reloadJobs = [];
    for (const entry of cache.entries()) {
      const readerPaths = [];
      for (const [readerPath, schema] of entry.data.schemas) {
        const watchedPaths = schema.watchedPaths || [];
        const schemaTouched = watchedPaths.some((schemaPath) => changedPaths.some(
          (changedPath) => changeCovers(changedPath, schemaPath),
        ));
        if (schemaTouched) readerPaths.push(readerPath);
      }
      if (readerPaths.length) reloadJobs.push(scheduleWork(entry.id, () => reloadSchemas(entry.id, readerPaths)));
    }
    await Promise.all(reloadJobs);
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
        ? { hash: null, error: SCHEMA_UNAVAILABLE, watchedPaths: [] }
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

  async function schemaForEdit(entry, filePath, text) {
    const previous = entry.data.files.get(filePath);
    const stored = entry.data.schemas.get(filePath);
    const modeline = readModeline(text) || '';
    if (previous && stored && (readModeline(previous.text) || '') === modeline) return stored;
    return loadSchemaFor(filePath, text, entry.data.dsl);
  }

  // A line edit re-parses that file only. Other layers and an unchanged schema stay.
  async function revise(entry, filePath) {
    const text = await textOf(filePath);
    const doc = analyzeDocument(text, filePath, entry.data.dsl);
    const files = new Map(entry.data.files);
    files.set(filePath, doc);
    const symbols = [];
    for (const layerPath of entry.data.paths) {
      const layer = layerPath === filePath ? doc : files.get(layerPath);
      if (layer) symbols.push(...layer.symbols);
    }
    const nextSchema = await schemaForEdit(entry, filePath, text);
    let schemas = entry.data.schemas;
    if (nextSchema !== storedSchema(entry, filePath)) {
      schemas = new Map(entry.data.schemas);
      schemas.set(filePath, nextSchema);
    }
    return cache.hold(entry.id, {
      ...entry.data,
      files,
      symbols,
      schemas,
    }, flagsFor(entry.id));
  }

  function storedSchema(entry, filePath) {
    return entry.data.schemas.get(filePath);
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
      if (!parsed.ok) configErrors.push({ dir: entry.dir, message: parsed.error });
      for (const dsl of parsed.dsls) dsls.push({ ...dsl, dir: entry.dir });
    }
    loadTerraformVocabulary();
    const builds = [];
    for (const doc of docs.values()) {
      if (doc.scheme !== 'file') continue;
      const claim = claimFile(doc.path, dsls);
      claims.set(doc.path, claim);
      if (claim.status === 'one') {
        builds.push(scheduleWork(stackIdFor(doc.path, claim.dsl), () => build(doc.path, claim.dsl)));
      }
    }
    await Promise.all(builds);
    refreshPins();
  }

  async function sync(uri, filePath, text) {
    if (parseFoldUri(uri)) {
      docs.set(uri, { uri, path: filePath, text, scheme: 'fold' });
      return;
    }
    const opening = !docs.has(uri);
    docs.set(uri, { uri, path: filePath, text, scheme: 'file' });
    const claim = claimFile(filePath, dsls);
    claims.set(filePath, claim);
    if (claim.status !== 'one') return;
    const id = stackIdFor(filePath, claim.dsl);
    await scheduleWork(id, async () => {
      const live = [...docs.values()].find((doc) => doc.scheme === 'file' && doc.path === filePath);
      if (!live) return;
      const entry = findEntry(filePath);
      if (entry && analyzed(filePath, live.text)) {
        if (opening) openedUris.add(uri);
        return;
      }
      if (entry) {
        await revise(entry, filePath);
        return;
      }
      await build(filePath, claim.dsl);
    });
    refreshPins();
  }

  async function warm(paths) {
    const seen = new Set();
    const builds = [];
    for (const filePath of paths || []) {
      const claim = claimFile(filePath, dsls);
      if (claim.status !== 'one') continue;
      const id = stackIdFor(filePath, claim.dsl);
      if (seen.has(id)) continue;
      seen.add(id);
      builds.push(scheduleWork(id, async () => {
        if (findEntry(filePath)) return;
        await build(filePath, claim.dsl);
      }));
    }
    await Promise.all(builds);
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
    const activeStackId = stackIdFor(activePath, claim.dsl);
    workQueue.promote(activeStackId, WORK_PRIORITY.active);
    const existing = findEntry(activePath);
    if (existing) cache.touch(existing.id);
    else {
      const requestedPath = activePath;
      await scheduleWork(activeStackId, async () => {
        if (findEntry(requestedPath)) return;
        await build(requestedPath, claim.dsl);
      });
    }
    refreshPins();
  }

  function setVisibleFolds(stackIds) {
    visible.clear();
    for (const id of stackIds || []) visible.add(id);
    refreshPins();
    for (const id of visible) cache.touch(id);
  }

  async function whenAnalyzed(uri) {
    const fold = parseFoldUri(uri);
    if (fold) {
      await workQueue.settledFor(fold.stackId);
      return;
    }
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return;
    const claim = claimFile(docInfo.path, dsls);
    if (claim.status !== 'one') return;
    const stackId = stackIdFor(docInfo.path, claim.dsl);
    workQueue.promote(stackId, priorityOf(stackId));
    if (!findEntry(docInfo.path) && !workQueue.hasWork(stackId)) {
      scheduleWork(stackId, async () => {
        if (findEntry(docInfo.path)) return;
        await build(docInfo.path, claim.dsl);
      });
    }
    await workQueue.settledFor(stackId);
  }

  function takeReanalyzedUris() {
    const stackIds = new Set(cache.takeReanalyzed());
    const reanalyzedUris = [...openedUris].filter((uri) => docs.has(uri));
    openedUris.clear();
    for (const doc of docs.values()) {
      if (doc.scheme === 'fold') {
        const foldTarget = parseFoldUri(doc.uri);
        if (foldTarget && stackIds.has(foldTarget.stackId)) reanalyzedUris.push(doc.uri);
        continue;
      }
      const entry = findEntry(doc.path);
      if (entry && stackIds.has(entry.id) && !reanalyzedUris.includes(doc.uri)) reanalyzedUris.push(doc.uri);
    }
    return reanalyzedUris;
  }

  function lineRange(line) {
    return { start: { line, character: 0 }, end: { line, character: 0 } };
  }

  function modelineLine(text) {
    const lineIndex = String(text || '').split('\n').findIndex((line) => readModeline(line) !== null);
    return lineIndex < 0 ? 0 : lineIndex;
  }

  function problems(uri) {
    if (uri.startsWith('file://') && path.basename(uriToPath(uri)) === 'yaml-dsl.yml') {
      const configDir = path.dirname(uriToPath(uri));
      return configErrors
        .filter((configError) => configError.dir === configDir)
        .map((configError) => ({ range: zeroRange(), message: configError.message }));
    }
    const doc = docs.get(uri);
    if (!doc || doc.scheme !== 'file') return [];
    const claim = claims.get(doc.path) || { status: 'none' };
    if (claim.status === 'many') {
      return [{ range: zeroRange(), message: `claimed by ${claim.ids.join(' and ')}` }];
    }
    if (claim.status !== 'one') return [];
    const entry = findEntry(doc.path);
    if (!entry) return [];
    const file = entry.data.files.get(doc.path);
    const fileProblems = [];
    const stack = stackOf(entry, doc.path);
    if (file) {
      for (const err of file.errors) fileProblems.push({ range: err.range, message: err.message });
      fileProblems.push(...analysisProblems(file, stack));
    }
    const schemaLine = lineRange(modelineLine(file ? file.text : ''));
    const schema = entry.data.schemas.get(doc.path);
    if (schema && schema.error) fileProblems.push({ range: schemaLine, message: schema.error });
    for (const message of stack.vocabulary ? stack.vocabulary.problems : []) {
      fileProblems.push({ range: schemaLine, message });
    }
    return fileProblems;
  }

  function decorations(uri) {
    return { references: references(uri), problems: problems(uri) };
  }

  function schemaFor(entry, filePath) {
    const schema = entry.data.schemas.get(filePath);
    if (!schema || !schema.hash) return null;
    return cache.schemaObject(schema.hash);
  }

  function usesTerraformVocabulary(dsl) {
    return Boolean(dsl.functions) && dsl.functions.vocabulary.some((source) => source.source === 'terraform');
  }

  function loadTerraformVocabulary() {
    if (terraformLoad || !dsls.some(usesTerraformVocabulary)) return terraformLoad;
    terraformLoad = terraformFunctions().then((metadata) => {
      terraformTable = terraformVocabulary(metadata);
      if (!terraformTable) return;
      for (const entry of cache.entries()) cache.replaceData(entry.id, entry.data);
      if (vocabularyListener) vocabularyListener();
    });
    return terraformLoad;
  }

  function onVocabularyLoaded(listener) {
    vocabularyListener = listener;
  }

  function vocabularyFor(entry, filePath) {
    const { functions } = entry.data.dsl;
    if (!functions) return null;
    const table = {};
    let complete = true;
    const vocabularyProblems = [];
    for (const source of functions.vocabulary) {
      if (source.source === 'terraform') {
        if (terraformTable) Object.assign(table, terraformTable);
        else complete = false;
        continue;
      }
      const published = schemaVocabulary(schemaFor(entry, filePath), source.pointer);
      if (published.vocabulary) Object.assign(table, published.vocabulary);
      else complete = false;
      if (published.problem) vocabularyProblems.push(published.problem);
    }
    return { table, complete, problems: vocabularyProblems };
  }

  function stackOf(entry, filePath = entry.data.common) {
    return {
      symbols: entry.data.symbols,
      common: entry.data.common,
      files: entry.data.files,
      root: entry.data.dsl && entry.data.dsl.dir,
      dsl: entry.data.dsl,
      vocabulary: vocabularyFor(entry, filePath),
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
      return hoverAt(doc, position, stackOf(entry, prefer), schemaFor(entry, prefer));
    }
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return null;
    const entry = findEntry(docInfo.path);
    if (!entry) return null;
    cache.touch(entry.id);
    return hoverAt(
      entry.data.files.get(docInfo.path),
      position,
      stackOf(entry, docInfo.path),
      schemaFor(entry, docInfo.path),
    );
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

  function analysisOf(uri) {
    const fold = parseFoldUri(uri);
    if (fold) {
      const entry = cache.get(fold.stackId);
      if (!entry) return null;
      const rendered = render(entry.data, fold.env);
      const prefer = entry.data.files.has(entry.data.overlays[fold.env])
        ? entry.data.overlays[fold.env]
        : entry.data.common;
      return { entry, doc: analyzeDocument(rendered.text, prefer, entry.data.dsl) };
    }
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return null;
    const entry = findEntry(docInfo.path);
    if (!entry) return null;
    return { entry, doc: entry.data.files.get(docInfo.path) };
  }

  function references(uri) {
    const analysis = analysisOf(uri);
    return analysis ? classifiedReferences(analysis.doc, stackOf(analysis.entry, analysis.doc.filePath)) : null;
  }

  function semanticTokens(uri) {
    const analysis = analysisOf(uri);
    return analysis ? tokensFor(analysis.doc, stackOf(analysis.entry, analysis.doc.filePath)) : [];
  }

  function sameSymbol(left, right) {
    return left.scope === right.scope && left.name === right.name;
  }

  function symbolsInFold(entry, filePath) {
    const { symbols, common: commonPath } = entry.data;
    if (!entry.data.layers) return symbols;
    const commonSymbols = symbols.filter((symbol) => symbol.file === commonPath);
    if (filePath !== commonPath) {
      return [...commonSymbols, ...symbols.filter((symbol) => symbol.file === filePath)];
    }
    const overlayPaths = entry.data.dsl.layers.environments.map((env) => entry.data.overlays[env]);
    if (overlayPaths.some((overlayPath) => !entry.data.files.has(overlayPath))) return commonSymbols;
    const [firstOverlay, ...otherOverlays] = overlayPaths;
    const inEveryOverlay = symbols.filter((symbol) => symbol.file === firstOverlay
      && otherOverlays.every((overlayPath) => symbols.some(
        (other) => other.file === overlayPath && sameSymbol(other, symbol),
      )));
    return [...commonSymbols, ...inEveryOverlay];
  }

  function completion(uri, position) {
    const docInfo = docs.get(uri);
    if (!docInfo || docInfo.scheme !== 'file') return [];
    const entry = findEntry(docInfo.path);
    if (!entry) return [];
    const lineText = docInfo.text.split('\n')[position.line] || '';
    const stack = { ...stackOf(entry, docInfo.path), symbols: symbolsInFold(entry, docInfo.path) };
    return completionAt(entry.data.files.get(docInfo.path), lineText, position, stack);
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
    warm,
    close,
    setActive,
    setVisibleFolds,
    problems,
    decorations,
    hover,
    definition,
    links,
    references,
    semanticTokens,
    completion,
    foldsFor,
    foldText,
    schemaWatchTargets,
    schemasChanged,
    takeReanalyzedUris,
    whenAnalyzed,
    cache,
    onVocabularyLoaded,
    vocabularyReady: () => terraformLoad || Promise.resolve(),
    takeEvicted: () => cache.takeEvicted(),
  };
}

module.exports = { createWorkspace, parseFoldUri, SCHEMA_UNAVAILABLE };

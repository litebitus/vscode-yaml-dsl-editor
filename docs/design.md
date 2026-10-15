# YAML DSL editor

Authoring `mock-dsl.yml` is hard without this extension:

- A stack is a common layer and its overlays. The file on screen is one of those, not an overlay's full config.
- A field's documentation sits beside a `$ref` the usual YAML tooling never reads.
- A `ref` and a `local` are strings, so nothing jumps to the declaration.

The extension is the editor that makes that document authorable.

## Generic by config

Any DSL written this way is a block in the workspace config, `yaml-dsl.yml`. Nothing about a particular DSL is compiled into the extension, and the config states every rule: the extension has no defaults, because every DSL is different. A DSL's block states:

- which files belong;
- its scopes;
- where names are declared, and how they are referenced;
- its placeholders and functions;
- when the DSL has layers, which directories are overlays;
- a fallback schema for a document that names none.

Scopes, references, placeholders and calls are generic: the editor validates, navigates, completes and hovers them the same way in every DSL. Each DSL's block supplies the syntax, and those syntaxes differ.

`mock-dsl.yml` is the DSL this document works through:

- Its field types are shared definitions, because a value may be a scalar, a `ref`, or a bare `local`.
- A simpler DSL uses the same engine through its own config block.
- It is the first config block, and its files are the first the editor is proven against.

Features are tuned iteratively. The first slice is what any editor for a programming language provides: hover documentation, and navigation of refs and locals. Diffing overlays, suggestions and extraction into the common layer follow, tuned the same way.

## Language server

The editor is a language server. Activating any `mock-dsl.yml` puts the whole stack in scope, the common layer and every adjacent overlay, and the server holds that context:

- Switching from one file of the stack to another uses it; rebuilding the stack on each switch would be slow.
- It keeps the stack current as the files change, the folded document of each overlay included.
- The folded documents are buffers in the editor view, so the author sees an overlay's full config instead of assembling it from the files.
- Hover and navigation run against the stack in scope, not against the active file alone.

### Analysis

On each change the server parses the changed YAML, reads that file's schema, and resolves references, placeholders and calls across the stack. Hover and navigation are requests against that analysis; problems and suggestions are further results of the same pass.

A problem has a severity, drawn in the color the DevOps tools print it in:

| Severity | At its range | In the gutter | Color |
|---|---|---|---|
| error | red text and a red squiggle | the error mark | the failure red |
| warning | its own mark, such as a struck-through key | a triangle | the warning yellow |
| info | a wavy underline, the text unchanged | the info mark | the info blue |

- A problem shows its message on hover.
- An empty range covers its whole line.
- The gutter marks share one size.
- An info problem is a schema the file names that cannot be loaded.

### Startup

The extension is an editor first, and nothing it does holds back the file. On startup, and for every newly opened file:

1. The file opens as its DSL's language at once, colored by the grammar, its references underlined from the text.
2. The suggestions saved from earlier sessions paint next, from the one file that keeps them.
3. Analysis starts in the background, and its classes, problems and suggestions paint as they land.

The workspace holds many stacks. The server loads one when a file in it is first opened, and loads no other. A resident stack is the parsed common layer, every adjacent overlay, the symbol index, and the folded document of each overlay. Switching files inside a resident stack is a hit.

### Work order

The file in the active editor is worked on first, ahead of all other files:

1. Work on the active file's stack.
2. The stacks of the other open files.
3. The suggestions of the active and open stacks.
4. Background work: the suggestions of stacks no editor has open.

- Open editors always come before background work.
- Work on the active file starts at once: a background job in progress waits at its next pause and resumes after it.
- Only work on the same stack waits for the job holding it.
- A request about a file is answered once that file's analysis is done.

```mermaid
flowchart LR
  subgraph interactiveLane["Interactive lane: starts at once"]
    activeAnalysis["Active stack's analysis"]
  end
  subgraph backgroundLane["Background lane: one job at a time, highest priority first"]
    direction TB
    openAnalysis["1. Open stacks' analysis"] --> openSuggestions["2. Active and open stacks' suggestions"]
    openSuggestions --> backgroundSuggestions["3. Suggestions of stacks no editor has open"]
  end
  interactiveLane -- "a background job waits at its next pause;<br/>a job on the same stack waits for the other" --> backgroundLane
  style interactiveLane fill:#FFB74D40
  style backgroundLane fill:#6495ED33
```

### Stack cache

The cache is bounded, and the unit is the stack:

- A stack with a file in an open editor is pinned, and so is a stack whose folded buffer is on screen. A pin is never evicted.
- Opening, editing, navigating into or showing a stack marks it most recently used. Background work is not use: rebuilding stacks after a config change keeps their places.
- Capacity beyond the pins is the setting `yaml-dsl-editor.cache.stackCapacity`.
- Loading a stack past that, or lowering the setting, evicts the least recently used unpinned stack: its analysis is dropped and its folded buffers close. The files on disk stay, and the next activation loads the stack again.
- A change to a resident stack updates it in place.

```mermaid
stateDiagram-v2
  direction LR
  Unloaded --> Pinned: a file in it opens,<br/>or its folded buffer is shown
  Pinned --> Resident: its last editor and folded buffer close
  Resident --> Pinned: a file in it opens
  Resident --> Unloaded: least recently used unpinned stack<br/>past yaml-dsl-editor.cache.stackCapacity
  Resident --> Resident: opened, edited, navigated into or shown:<br/>most recently used
```

### Schema cache

A stack's schema is the `schema.json` of the grammar version that stack initialized:

- The same grammar version is the same schema, so every stack on that version shares one parsed copy.
- A different grammar version is a different schema, however small the difference, and hover for a stack uses its own version's schema.
- The cache's unit is the distinct schema, one entry per hash. Bytes identical to a schema the server holds are that schema and are not parsed again.
- A schema a resident stack uses is pinned. Capacity beyond the pins is the setting `yaml-dsl-editor.cache.schemaCapacity`; past it, the least recently used schema is dropped.
- Evicting a stack unpins the schemas only it used.
- What the extension works out from a schema, such as the node fingerprints and validators of the schema checks, belongs to the schema's entry and goes with it.

### Inputs

Every input takes effect without reloading the window:

| Input | Effect |
|---|---|
| a `yaml-dsl.yml` saved, created or deleted; a workspace folder added or removed | the configs reload; every resident stack is analyzed again under them, and a stack they no longer claim is dropped |
| a path a resident file's schema search reads changes | that file's schema reloads; a schema on disk changes when its stack is initialized again |
| a layer file of a resident stack changes on disk while no editor has it open | the file is read again |
| a layer file is deleted from disk | the file leaves the stack, even while an editor holds it with no unsaved edits, and comes back when it returns to disk |
| a layer file's editor closes | the file is read from disk again, so discarded edits, or a file gone from disk, leave the stack with what the disk holds |
| an extension setting changes | it applies at once |

Terraform's function metadata is read once per session.

### Output

The YAML DSL output channel exists from activation and logs:

- each startup step;
- the build of the extension it runs;
- the first analysis of each opened file, with its time;
- every failure.

A startup step that fails is logged and skipped, so the language server always starts and the file always shows.

### Boundaries and tests

- The server does not run the engine. The continuous compile is the editor's analysis; plan and admission stay with the engine.
- The extension process is the client. The analysis is a plain module with no editor API in it, tested on its own with `node --test`. Editor features stay in the language server.
- Line coverage and branch coverage of the extension's own code are each at least 90%. The `node --test` run measures both and fails if either is under that; test files are not part of the measured set.

## Common layer and overlays

A layered DSL's stack is one common layer and its overlays:

- Each overlay is a `mock-dsl.yml` under an overlay directory, one `layers.overlay_folders` names, such as `overlay-1` or `overlay-2`, directly below the common layer's directory.
- A file below no overlay directory is a common layer.
- The engine deep-merges the common layer under the overlay. The folded document is what a plan sees.

`layers.common_layer_discovery` states how far below the overlay directory an overlay file sits:

| Value | The overlay file | Example |
|---|---|---|
| `parent` | is in the overlay directory itself | `concern-1/overlay-1/mock-dsl.yml` |
| `ancestor` | may sit deeper, at the same path below the overlay directory in every overlay | `concern-group/overlay-1/concern-1/mock-dsl.yml` takes `concern-group/mock-dsl.yml`, the nearest ancestor above an overlay directory |

### Concerns

A file's concern is the nearest directory above it that is not an overlay directory:

| File | Concern | Kind |
|---|---|---|
| `concern-1/overlay-1/mock-dsl.yml` | `concern-1` | a concern above its overlays |
| `concern-group/overlay-1/concern-1/mock-dsl.yml` | `concern-1` | a concern below its overlays |

A concern's overlays and the common layer they take are one stack. `layers.common_layer_files` maps an overlay's file name to the names its common layer may take in the overlay directories' parent:

- The names are tried in order, and the first that exists is the common layer.
- A name holding `{concern}` is a concern's own common layer, tried only for a concern below its overlays.
- A file whose name has no entry takes a common layer of its own name.
- A file a `{concern}` name matches belongs to the DSL as a common layer, whatever `file_includes` says.

```yaml
common_layer_files:
  mock-dsl.yml: ["{concern}.mock-dsl.yml", mock-dsl.yml]
```

Under this entry, `concern-group/overlay-1/concern-1/mock-dsl.yml` takes `concern-group/concern-1.mock-dsl.yml`, else the fallback `concern-group/mock-dsl.yml`.

### Folded documents

An author editing one of those files sees only that file, so the language server buffers the stack in the editor view:

- Each overlay's folded document is the common layer merged with that overlay.
- Shared config lives in the common layer, a local that a resource references included.
- While any file of the stack is active, refs and locals resolve in that file's fold.
- Across overlays the editor diffs the folded documents.

A block repeated in every overlay is one edit away from drifting: the next change lands in a single overlay and the others keep the old copy. The editor suggests moving that block into the common layer, and one click applies it.

### Concern above its overlays

```
concern-1/
├── mock-dsl.yml  # common layer of concern-1
├── overlay-1/mock-dsl.yml  # overlay-1 of concern-1
└── overlay-2/mock-dsl.yml  # overlay-2 of concern-1
concern-2/
├── mock-dsl.yml  # common layer of concern-2
├── overlay-1/mock-dsl.yml  # overlay-1 of concern-2
└── overlay-2/mock-dsl.yml  # overlay-2 of concern-2
```

```yaml
layers:
  overlay_folders: [overlay-1, overlay-2]
  common_layer_discovery: parent
```

### Concern below its overlays

```
concern-group/
├── mock-dsl.yml  # fallback common layer, for a concern without its own
├── concern-1.mock-dsl.yml  # common layer of concern-1
├── overlay-1/
│   ├── concern-1/mock-dsl.yml  # overlay-1 of concern-1
│   └── concern-2/mock-dsl.yml  # overlay-1 of concern-2
└── overlay-2/
    ├── concern-1/mock-dsl.yml  # overlay-2 of concern-1
    └── concern-2/mock-dsl.yml  # overlay-2 of concern-2
```

```yaml
layers:
  overlay_folders: [overlay-1, overlay-2]
  common_layer_discovery: ancestor
  common_layer_files:
    mock-dsl.yml: ["{concern}.mock-dsl.yml", mock-dsl.yml]
```

A DSL with both takes this config, since `ancestor` also reaches a concern above its overlays.

## Formatting

Claimed files have a document formatter. It changes indentation and whitespace. Comments, key order, and the spelling of scalars stay, so a format pass does not rewrite a `ref`, a `local`, or a `${...}` placeholder into a different string.

## Paths

Every path in the config is a JSONPath query (RFC 9535) in this subset:

| Step | Selects |
|---|---|
| `$` | the document root, the map that holds the top-level keys |
| `.name` | the key `name` |
| `.*`, `[*]` | every child of a map or a list |
| `..*`, final only | every node below the path before it, not that node itself |

- A node and everything below it are two entries, `P` and `P..*`.
- An entry's `skip_keys` lists keys a `.*`, `[*]` or `..*` step does not select or descend into.
- In a list of path entries, the path names the entry and appears once.

## Scopes

A DSL is a language, and its names live in scopes. Every scope a rule names is declared under `scopes`:

| Field | Meaning |
|---|---|
| `regions` | where the scope's names may be referenced: each path's region is the subtree under every node it selects, in any file of the fold; `$` is all of it |
| `later_items_of_declaring_list` | a name is also visible in the later items of the list that declares it, at any depth inside them |
| `named_by_parent_key` | the mapping key enclosing a declaration is the scope its name is in |
| `builtin_names` | the names of a logical scope |

- A scope named in capitals is logical: the config lists its `builtin_names`, and the word never appears in a document.
- Any other scope is literal: its name is the DSL's own word, and the document declares its names.
- Builtins valid only in some regions are a logical scope of their own, apart from the true globals.

### Declaration rules

A declaration rule says where names are declared: each node its `path` selects is a declaration.

| Field | Meaning |
|---|---|
| `skip_keys` | keys a step does not descend into |
| `exclude_candidates` | keys at the last step that are not declarations |
| `name_source` | where the name is read: the `key`, the scalar `value`, or the `meta_argument` named by `meta_argument_name` of a key such as `http(id=config)`, one name per listed id |
| `declares_every_name` | the key declares every name of the scope, for a scope whose names are defined in a document the editor does not read, such as one whose path holds a placeholder; each name resolves to the key that names the document |
| `key_token` | the part of the key that is the name: `all_words`, `first_word` or `last_word`; `null` for a name not read from the key |
| `name_spelling` | `as_written` or `dashes_as_underscores` |
| `scope_name` | the scope declared under `scopes` |

### Reference rules

A reference rule says how names are used. `pattern` is a regular expression with named groups.

| Field | Meaning |
|---|---|
| `positions` | where a reference may stand, below |
| `text_after_name_allowed` | whether text such as a field path may follow the name |
| `scope_name` | the scope it resolves in |
| `scope_group` | the pattern group holding the scope of a `named_by_parent_key` scope; `null` otherwise |
| `name_group` | the group holding the name |

| Position | A reference is |
|---|---|
| `whole_scalar` | the scalar |
| `whole_placeholder` | a placeholder that is the whole scalar |
| `placeholder_in_text` | a placeholder inside longer text |
| `anywhere_in_scalar` | each match inside a scalar |

### Resolution

- A reference resolves to a builtin of its target scope whose region holds the reference, else to a symbol of that scope, with that name, visible from the reference.
- When several rules read the same text, each is tried in order, and the first that resolves is the reading.
- A name that holds a local placeholder is also known by the local's value, spelled by its declaration rule: a key `name ${local.thing}` whose local is `mock-thing` is the name `mock_thing`.
- An overlay's own declaration wins over the common layer's, as it does in the merge, and an overlay sees no other overlay's declarations.
- A reference in the common layer resolves in the fold of each overlay whose merge keeps it, and is an error unless it resolves in every one of them. An overlay that replaces or deletes the value or key holding it is not asked. When no overlay keeps it, it resolves in the common layer alone.
- It names the declaration it reaches in each of those folds, in `layers.overlay_folders` order.

## Locals

A local is a named value. `locals.scope_name` names the scope whose declarations are the DSL's locals; that scope is declared under `scopes` like any other, a declaration rule reads its names from keys, and a reference rule reads them. A DSL without the `locals` block has no locals.

- A local's value is its declaration's value as written, with every local it references replaced by that local's value, resolved recursively in the file's fold.
- An overlay's local wins over the common layer's.
- Each fold resolves each local once, and an edit resolves the edited file's folds again.
- A local that reaches itself through its references is a problem on its declaration, and its value stays as written.
- A reference to anything other than a local stays as written inside the value.
- A key holding a local placeholder is also known by the local's value.
- Moving a block into the common layer writes each difference as a local.

## Navigating references

| Action | On a reference naming one declaration | On a reference naming several | On a builtin, or nothing visible |
|---|---|---|---|
| Go to definition | opens the declaration | does not move | does not move |
| Command-click | opens the declaration | opens a popup at the reference showing them all | does not move |
| Resting the pointer | no popup of the extension's | the editor's Command-click tooltip on its link | an error reads `Invalid reference: <scope>.<name>` |

- The popup shows the declarations in this language, each section headed by its overlay's name, `common layer` for the common layer's; the heading opens the declaration.
- A reference nothing visible declares is an error. A builtin has no declaration.
- The references peek is not opened.

In `mock-dsl.yml`:

- A ref is a whole scalar `ref <type>.<name>`, with an optional field path after the name. Its scope is `<type>`, the mapping key enclosing the resource.
- A local is a key under `locals`, referenced as a whole scalar `local.<name>` or as `${local.<name>}` inside a scalar.
- A value shared by resources is a local in the common layer.

### Classes

The editor underlines each reference from the text as soon as the file opens, using the config's reference rules, and redraws it by its class once the analysis answers:

| Class | Resolves | Drawn |
|---|---|---|
| local | in the same file | a straight underline, the text's own colors |
| external | in another file of the stack | a squiggle, the text's own colors |
| error | nowhere visible | red text and squiggle, with an error mark in the gutter |

The whole reference takes its class's underline, placeholders inside it included.

### Coloring

- The editor colors references, placeholders and calls from the config: a reference rule's leading literal, its target groups and its other literal text; a placeholder's delimiters and builtin body; a call's marker, function and splat.
- The grammar colors plain YAML only, as the HCL editor colors HCL: keys are identifiers, strings are strings, and numbers and `true` / `false` / `null` are constants.
- The extension takes the whole of a file's coloring, so the editor's bracket pair colorization does not apply: a bracket keeps the color of the text it stands in.
- A `#` starts a comment only at the start of a line or after whitespace.
- A matching file takes the extension's file icon.

## Renaming

Rename Symbol, from its shortcut or the context menu, renames a name of a scope across the stack:

- every declaration of it, in the common layer and every overlay, since an overlay overrides a declaration by repeating its name;
- every reference that reads it, in every file of the stack, each taking the new name in the spelling of the declaration rule.

The rename box shows the name as declared. A rename is refused, with the reason, for:

- a builtin;
- a name declared for every name at once;
- a name made of a local's value;
- a name the scope already declares;
- a new name the edited files do not read back as that name.

A declaration whose name is edited by hand, while other declarations or references in the stack still use the name it had, gets a suggestion to rename it everywhere: the same edit as Rename Symbol, applied and saved like a move.

- The name it had is the one the rest of the stack last used, so a rename that leaves nothing using that name forgets it.
- Declarations renamed by hand from one name to the same new name are copies of one rename, not a clash.

## Completion

Typing the start of a reference opens the list of what it can name.

- Each config reference rule is a literal with named groups, which the editor turns into a template: `^ref (?<type>…)\.(?<name>…)` writes `ref <type>.<name>`.
- A symbol fills the template, and the result is kept only when the rule's own pattern reads it back as that symbol.
- A rule whose pattern is not a literal with named groups offers nothing.

The list holds what the file's fold sees and what is visible from the cursor:

| Where | The list holds |
|---|---|
| an overlay | the common layer's symbols and its own |
| the common layer | its own symbols, and those declared in every overlay |
| inside a placeholder | every reference a placeholder body may be, builtins included |
| after a call marker in a key | the vocabulary, each entry with its signature |

- A resource keyed by a local is offered under the local's value, the spelling a ref uses for it.
- A ref completes up to the resource name; the field path after it is the author's.
- The list opens as the reference starts and narrows on every character, by the editor's fuzzy match against everything typed since the reference began.
- Each entry names the declaring file and shows the declaration as authored.

## Hover documentation

The Red Hat YAML extension is not used: it resolves a field to the schema node a draft-07 validator sees, and for these DSLs that node is a shared value definition.

A field's value `$ref`s a composite such as `string_or_ref` or `string_list_or_ref`, because the value may be a scalar, a `ref`, or a bare `local`, and the field's own documentation is written beside that `$ref`. Draft-07 ignores every keyword beside a `$ref`, so a compliant hover shows the composite's text, "a literal string, a `ref`, or a bare `local`", and never the field's:

```json
"label": {
  "$ref": "#/definitions/string_or_ref",
  "description": "[required] Mock label for the thing (or `ref`)."
}
```

A schema for this kind of value is built this way. This extension reads the schema document as authored:

- Hover walks the YAML path through `properties`, then `patternProperties`, then what the schema's draft reads for a key `properties` does not list.
- On an object that carries both a `$ref` and a `description`, it keeps that `description`, then follows the `$ref` only to keep walking.
- The tooltip is the description kept at the field, requirement marker included. The composite's description is the value shape and is not the tooltip.

### Requirement markers

A requirement marker is the extension's standard for saying whether a key must be present. A field's `description` opens with it:

| Marker | The key |
|---|---|
| `[required]` | is present in every folded document |
| `[~required]` | is present under a condition the schema does not state |
| `[optional]` | may be absent |

- A marker states the field author's intent beside the field itself, so where a field carries one, the marker decides and its parent's `required` array is not read for that key.
- A field without a marker is required when its parent's `required` array lists it.
- Every schema check the extension runs reads requiredness this way.

### Finding the schema

| Source | Used |
|---|---|
| a `# yaml-language-server: $schema=` modeline | first; its path is relative to the file |
| `schema_search_paths`, a list, `[]` when empty | when the file has no modeline, or the path it names is not on disk; each entry is relative to the file, and the first on disk is the schema |

- A modeline points at the schema shipped with the grammar version the stack has initialized: an overlay names `.schema/sample.schema.json`, and a common layer names it through the overlay directory that initialized the stack, such as `one/.schema/sample.schema.json`.
- A URL in a path is fetched. The search does not override a modeline that resolves.
- The extension embeds no schema.
- When neither source resolves, the file's modeline line gets a problem, or its first line when it has no modeline, and field hovers stay empty. Navigation, other problems and suggestions still run.

### What the schema is for

- DSL-level behavior is configured in `yaml-dsl.yml`: which files, the scopes, the syntax of declarations, references, placeholders and calls, how layers are grouped. The concepts are the editor's, the syntax is the DSL's, and that syntax does not move into the schema.
- The schema is how the editor understands a field and the shape of an object: which keys exist, what value shape a key takes, and the field's own description, the text beside a `$ref` included. It is read as published.
- When the schema is not enough to understand a field or a shape, the schema gains an extension point and the grammar publishes it; the extension does not grow a special case for that object. No such point is added before a field or a shape requires one.
- The schema is not the engine's checks, which are a separate pass. A check can require a group of fields only when another field has a certain value, allow a field for only one mode, or allow exactly one of two fields; the published schema has no such table, and an extension point is not a transcription of these checks.
- A field may be filled from the common layer while the editor looks at one file, so a `required` array on the resource alone does not say whether the folded document is complete.

## JSON Schema drafts

The editor reads:

- draft-07
- draft 2019-09
- draft 2020-12

A schema's draft:

- is the one its root `$schema` names;
- is draft-07 when it names none or an older draft;
- is not read when it names any other draft: the modeline line gets an info problem naming the URI and the drafts the editor reads, and field hovers stay empty.

### Parsers

Each draft has a parser named after it, over one shared core. The core:

- picks the parser from `$schema`;
- resolves references;
- merges the schemas an applicator combines;
- finds the node at a document path, and a node's fields.

A parser states what its draft's keywords mean:

| | draft-07 | draft 2019-09 | draft 2020-12 |
|---|---|---|---|
| list items | `items`, `additionalItems` after a tuple | `items`, `additionalItems` after a tuple | `prefixItems`, then `items` |
| references | `$ref`, `$id` plain-name fragment | `$ref`, `$anchor`, `$recursiveRef` | `$ref`, `$anchor`, `$dynamicAnchor`, `$dynamicRef` |
| a key `properties` does not list | `additionalProperties` | `additionalProperties`, then `unevaluatedProperties` | `additionalProperties`, then `unevaluatedProperties` |
| merged as `allOf` merges | `allOf` | `allOf`, `dependentSchemas` | `allOf`, `dependentSchemas` |
| `deprecated` | not read | read | read |
| opt-out validator | draft-07 | draft 2019-09 | draft 2020-12 |

### Deprecated fields

In a draft that reads `deprecated`, a field whose node, or a node its references reach, holds `deprecated: true` is a warning:

- its key is struck through in the warning yellow;
- the hover of its key and its value is the warning: `` `<key>` is deprecated: <description> ``;
- its file, and every folder above it, are named in the warning yellow, with a `⚠` badge on the file and its tab.

A stack's report of its suggestions flags each file holding a warning, for a stack worked out in the background as for one an editor has open, and the flag is kept with the file's suggestions. A warning's color and badge show over a suggestion's.

| Setting | `false` turns off |
|---|---|
| `yaml-dsl-editor.warning.deprecation.enabled` | all of the above |
| `yaml-dsl-editor.warning.deprecation.fileDecoration` | the file and folder color and badge |

## Diffing across overlays

How a block is configured differently across overlays is read in one view, never by opening each overlay file and comparing by eye.

### Opening the view

- A diff button sits in the title bar of every layer file on disk, and the Command Palette offers it.
- While lines are selected, `Diff across overlays` tops the editor's context menu, whether or not a suggestion exists.
- With nothing selected, the diff takes the key on the cursor's line.
- One click opens the view with every overlay, beside the file, leaving the focus there.
- A button on the view, or the Command Palette while the view is active, chooses which overlays it diffs, the current ones checked, and renders it again with them.
- While the view is open it follows the selection: selecting lines in any layer file of its stack renders it again with the same overlays.

The view is a read-only document titled with the stack's path from the workspace root, overlay directory and file name left out. It shows the differences; resolving them is the author's.

### What the view shows

- The first line names the overlays it diffs and how many differences it found, `no differences` when they all agree.
- It diffs the keys the selected lines hold, their nested lines included, and writes the path from the document root down to them as plain lines for context.
- It renders them the way a move writes a block into the common layer: copied from the first overlay that holds them, in that overlay's key order, a list or map value in flow style.
- Each overlay's side is its folded document, the common layer merged with the overlay file by the engine's deep merge.
- Comments are never a difference.

| Case | Written |
|---|---|
| a line every checked overlay folds alike | once |
| a key whose value differs | once per distinct value, the lines grouped together, each labeled with the overlays that hold it in `layers.overlay_folders` order |
| a key an overlay lacks | struck, `key:`, among that key's lines and labeled with the overlay; its parents stay plain lines, so a missing key is struck at its leaf wherever it sits |
| a block an overlay lacks entirely | struck once at its key, above the block; the lines below diff the overlays that hold it |

Each difference, every line of one key, takes one background color, the next difference the next color of a palette of mellow shades contributed as theme colors, so adjacent differences never share one.

```
mocktype:
  shared:
    label: mock-shared
~   size: 1  # overlay-1, overlay-3
~   size: 2  # overlay-2
    retention:
~     days: 7  # overlay-1, overlay-3
~     d̶a̶y̶s̶:̶  # overlay-2
    tags: [a]
```

## Suggestions

The extension suggests an edit where it can see one. A suggestion shows as:

- a light bulb in the gutter of the line it concerns;
- an inlay hint at the end of that line, whose hover says what the edit does and links to it;
- the holding file's name in the light bulb's color, with a light bulb badge in the Explorer and on its tab, every folder above it up to the workspace root taking the color.

Each folder above a decorated file is decorated in its own right, so its color shows over the one a child's decoration carries up, such as source control's.

The edit:

- runs only on a click of the hover's link, once per click, and dismisses the hover;
- leaves no standing order behind it, and the hint itself takes no click;
- passes the schema of every file it writes.

Inlay hints:

- are on for the extension's own files, whatever the editor's default;
- read whole: the extension sets `editor.inlayHints.maximumLength`, and a user's own setting for the language still wins;
- come back after an empty answer: an editor stops asking a file that answered none, so the extension registers its provider again when suggestions reach that file.

Each kind of suggestion has its own settings under `yaml-dsl-editor.suggestion.<kind>`:

| Kind | The suggestion | Colors its file |
|---|---|---|
| `delete` | deleting a duplicate | yes |
| `move` | a move | yes |
| `potentialMove` | a potential move | no |
| `rename` | renaming a name edited by hand everywhere | yes |

| Setting | `false` turns off |
|---|---|
| `enabled` | the kind's suggestions |
| `fileDecoration` | the kind's file and folder color and badge, for a kind that colors its file |

Extraction into the common layer is one such suggestion.

### When suggestions are worked out

- Loading a stack starts its quiet period, and each edit to it restarts the period.
- Once the stack has had no edit for 500 ms, its suggestions are worked out behind the analysis of every open file, and sent apart from problems and underlines.
- Typing never waits for them.

### Kept suggestions

A file's suggestions outlive its stack leaving the cache and a restart of the editor:

| | |
|---|---|
| where | the extension's global storage, in a folder per workspace named by the hash of the workspace file or its lone folder, so uninstalling the extension deletes them with it |
| key | the file, with a hash of the text they were worked out from |
| build | the build of the extension that worked them out, a hash of its manifest and code |
| shown | until the stack is analyzed again; on startup as soon as they are read, their hashes checked after, in the background |

- Suggestions another build worked out are never shown; the stack of each of their files still on disk is worked out again in the background.
- A file whose text on disk no longer matches its hash, at startup or when it changes on disk, loses its kept suggestions, and its stack is worked out again in the background without entering the cache.
- A click on a kept suggestion loads its stack and works it out afresh before writing anything.
- The kept file carries a format version. A breaking change to the format bumps it, and the extension migrates an older file to the current format when it loads.
- A file no migration reads is deleted, and its suggestions come back as their stacks are analyzed; the user never sees it.
- A field added to a suggestion reads as empty where an older file lacks it.

```mermaid
sequenceDiagram
  participant Storage as Global storage
  participant Editor
  participant Server as Language server
  Note over Storage,Server: A stack is edited
  Editor->>Server: edit
  Editor->>Editor: clear the edited file's marks
  Server->>Server: restart the stack's 500 ms quiet period
  Server->>Server: once quiet, queue its suggestions
  Server-->>Editor: suggestions, each file with its marks and text hash
  Editor->>Editor: light bulbs, inlay hints, file colors
  Editor->>Storage: save marks a second after the last report
  Note over Storage,Server: The user clicks a suggestion's hover link
  Editor->>Server: apply the suggestion
  Server->>Server: load the stack, work it out afresh
  Server-->>Editor: edits, each file saved
  Note over Storage,Server: A stack leaves the cache
  Server-->>Editor: stack evicted
  Editor->>Editor: keep its marks until the stack is analyzed again
  Note over Storage,Server: The editor starts
  Editor->>Storage: read saved marks
  Editor->>Editor: light bulbs, inlay hints, file colors
  Editor->>Server: workspace config
  Editor->>Editor: hash each file on disk, drop the marks whose hash differs
  Editor->>Server: refresh the stacks of files whose hash differs
  Server->>Server: work each stack out without entering the cache
  Server-->>Editor: suggestions, each file with its marks and text hash
  Note over Storage,Server: A file changes outside the editor
  Editor->>Editor: hash differs, drop its marks
  Editor->>Server: refresh its stack
```

## Extracting the common layer

A unit that every overlay states for itself will drift: the next edit changes one overlay, and the others keep the old copy. Extraction puts that unit in the common layer so the stack has one copy.

### Units

A move takes one unit whole. `layers.duplicate_check` places the unit:

| Field | Meaning |
|---|---|
| `depth` | the unit sits this many levels below the document root; a key counts as one level, so `a.b.c` is three levels deep |
| `key_depths` | the unit's depth under a top-level key it lists |
| `skip_keys` | keys no suggestion compares or moves, at any depth |

- A scalar or list above that depth is a unit of its own.
- Nothing inside a unit moves on its own, and nothing above it moves as one block, so a unit never ends up split between the common layer and an overlay.
- In the resource DSL the unit is a resource, `type.name`, two levels deep.

Values are compared as written:

- A reference, a local and a placeholder are their text, whatever they resolve to.
- Maps are compared key by key, and lists whose items match in number item by item; a list whose items differ in number is one difference.
- A map unit with a difference is offered only in a DSL with locals, outside the locals, and only when at least one leaf is the same in every overlay that holds it, since the difference is written as a local and the unit lands whole in the common layer.

### Moves and potential moves

Every place where the overlays disagree on a unit is a difference:

- a value that differs;
- a list or map some overlay lacks;
- a scalar some overlay lacks;
- the unit itself missing from an overlay.

What the click writes into an overlay draws the line:

| Differences | Offered as | The click |
|---|---|---|
| none: every overlay holds the unit, all alike | a move | deletes the copies and writes one into the common layer; no overlay gains anything |
| one | a potential move, with a link | also writes into an overlay to keep its fold, so the user decides |
| more than one | not offered | |

An overlay's fold is kept by what is written for it:

| The overlay lacks | Written for it |
|---|---|
| a list | `[]` |
| a map | `{}` |
| a scalar | the `default` its schema node states; with no stated default, the unit is not offered |

A potential move is information: its gutter mark is the info mark, its hint starts with `ⓘ`, and it colors neither its file's name nor any folder above it.

### Schema checks

A block the walk finds passes two schema checks before it is offered:

1. Every overlay with a file, holding the block or not, reads the node at the block's path in its own schema, and those nodes must be the same. A node is compared by a hash of it with its references resolved, its annotations (`description`, `title`, `examples`, `$comment`) set aside and its requirement marker kept, cached per schema node.
2. Each opt-out passes the node at its own path in the schema of the overlay that takes it: `{}`, `[]` or the default, with requiredness read from the requirement markers.

A block that fails either check is a potential move with no link:

- Its hint names the check that failed.
- Its hover lists the overlays and the schema's own messages, so the user decides the fix.
- A failed `anyOf` or `oneOf` is listed as its alternatives, each with its own failures, and a failed `not` reads as the description of the schema it sits in, so the user reads the schema's intent without opening it.
- Once the schemas agree, or the overlays hold the block, the suggestions worked out next offer the move.

A field directly under the node marked `[~required]` is one the `{}` opt-out leaves out, and the extension does not read the condition. A block whose opt-out leaves one out is a potential move that keeps its link:

- Its hover names the overlays and those fields, and says the extension cannot tell whether the move is safe.
- The user may judge it safe, and the click applies the move as any other.

### The common layer file

- A stack whose common layer file does not exist yet is the starting point extraction is for: its moves read the common layer as empty, and the click creates the file.
- A new common layer starts with the keys `layers.duplicate_check.skip_keys` names that every overlay holds the same, since those are the keys each layer states for itself.
- A move writes into the first of the names `layers.common_layer_files` tries for the stack.
- When that file does not exist and a later name's does, the click creates it as a new common layer, holding the blocks of the common layer the overlays fold with now that their references reach, and the blocks the references inside those reach, each opened under its parent maps. Suggestions are worked out against that file.

### Moving a map unit

One click on a map unit:

1. Writes the unit into the common layer, copied from the first overlay in `layers.overlay_folders` order that holds every difference, comments, key order and the blank lines around it included, the difference replaced by a reference to its local.
2. Declares the difference's local, below.
3. Deletes the unit from each overlay that holds it, and a parent map left empty by that, merging the blank lines around it into one, and taking the blank lines after it when it sits right under its parent's key.
4. Writes `{}` at the unit's path into each overlay with a file that does not hold it.
5. Saves every file it changed.

The difference's local:

| Case | The common layer declares | Each other overlay declares |
|---|---|---|
| one value is held by the most overlays | that value | its own value, or `[]`, `{}` or the schema default where it lacks the key |
| no one value is held by the most overlays | the empty value of their type: `""`, `0`, `false`, `[]` or `{}`, so the name resolves in an overlay that opts out | its own value |
| tied values of differing types, or `null` | no move is offered | |

A list or map in block style is declared on the lines below the local's name.

- After the click every overlay's folded document reads the same at the unit's path, with the new locals resolved, except where an overlay opts out: it holds its `{}`, `[]` or schema default there.
- Before writing anything, the click applies its edits to a copy of each file, folds the copies and compares them at the block's path. A mismatch writes nothing and says so.
- The hover names the block and how many overlays hold it, each difference with its values and the overlays holding each, and the overlays that opt out.

### Moving a value

A scalar, a list or a map in flow style is a unit by value:

- An overlay's value at its path is what its fold holds there: its own value, else the common layer's.
- When more than half the overlays that have a file, and at least two, hold one value the common layer does not, the editor suggests moving it into the common layer. The common layer's own value casts no vote.
- Every overlay holding another value, keeping the common layer's former value, or lacking it, is the unit's one difference.

One click:

1. Writes the value into the common layer at the path, over what the common layer held there, opening the maps above it the common layer lacks.
2. Deletes it from each overlay holding it, and a parent map left empty by that.
3. Writes the common layer's former value into each overlay whose fold held it.
4. Leaves each overlay holding another value with its own.
5. Writes `[]`, `{}` or the schema default into each overlay whose fold held nothing.
6. Saves every file it changed.

- A map where the common layer also holds a map, or where an overlay keeping its own value holds a map, merges, and is not moved by value.
- An empty map or list is an opt-out, not content, and is not moved.
- The hover also names the overlays that keep the common layer's former value and those that keep their own.

### Combined moves

Moves of neighboring keys in one map are one move. Two moves combine when:

- the same overlays hold each;
- the same overlays opt out;
- each key follows the other in every overlay holding them;
- the combined move holds at most one difference.

- Its hint names the keys, and its hover lists the blocks in order.
- The click writes them into the common layer one after another in that order, each placed and spaced by the overlays as they stood before the click, and each checked against the folds as a move of its own.
- While the cursor is on a suggestion's light bulb line, a border marks every line the suggestion takes.

### Deleting a duplicate

What an overlay holds the same as the common layer at the same path, no deeper than the unit, is a duplicate, and the editor suggests deleting it from that overlay at its topmost path.

- A key whose value is empty in the overlay or the common layer is not a duplicate, because an overlay's `null` deletes the key.
- One click deletes the duplicate, and a parent map left empty by that, and saves the file.
- That overlay's folded document reads the same after it.

### Applying a click

A key's comment is the comment lines directly above it, at its indentation. A click carries a key's comment with the key:

- Deleting a key deletes its comment.
- A key written from another file, or a map a move opens in the common layer, takes the comment it has there.

A new key goes where `key_sort_orders` says for the map it lands in. Each entry names a path and an `order`, and the first entry whose path selects the map applies, so specific paths come first.

| `order` | Places a new key |
|---|---|
| `alphabetical` | at its sorted place within the keys at the top of the map that are already in order, and where that order breaks when it sorts after them all; the keys after the break are not considered |
| `significance` | by three groups: the keys `first_keys` lists, in its order; every other key; then the keys `last_keys` lists, in its order |

Under `significance`:

- A listed key goes before the first key of the map that ranks after it.
- Any other key goes where the overlays holding it place it among the other keys: before the next of its neighbors there that the map holds, else after the previous one, taking the overlays in `layers.overlay_folders` order, and at the end of the other keys when none of its neighbors is there.
- Both lists are `[]` under `alphabetical`, and a key sits in at most one of them.

- Keys already in the map keep their order.
- A map no entry covers takes no new key, and a suggestion that would write one is not made.

Blank lines around a new key:

- It takes the blank lines above and below it in the first overlay holding it, in `layers.overlay_folders` order.
- A key no overlay holds takes one blank line above and below when it spans more than one line, and none when it is one line.
- The count includes the blank lines already beside where the key lands once every edit of the click is made, and none are added at the top or the end of the file.

Undo:

- A click is one undo step across every file it changes.
- An undo or redo that brings one of them back to its text before or after a click saves it, so undoing a move leaves no file to save by hand.
- Undoing a click that created a file removes the file, and nothing saves it.

### Naming locals

A local is named by the block's key and the nearest named key above the leaf, joined with `_`:

- A named key is any key between them, except a key a `declarations` rule reads a name from, a list item, and a call.
- A call key contributes the name written before its call marker, and a call without a name contributes nothing.
- A name the stack already declares takes the next named key up in front of the nearest one, and once those run out, the block's ancestors' keys.
- The reference is the local reference rule's own form: a whole scalar where the rule allows one, else a placeholder.
- A difference whose name the reference rule cannot read back, and a map the edits must write into that is in flow style, are not suggested.

### Node ids

The parse gives every node an id from a table its stack shares:

| Node | Id from |
|---|---|
| a scalar | its type and value |
| a list | its items' ids, in order |
| a map | its keys and their values' ids, keys sorted |

- A second id counts every scalar alike, so two blocks with the same keys at every depth share it.
- Equal ids are equal values, so comparing two blocks is comparing two numbers; comments, quoting, flow or block style and key order do not count.
- Each id sits beside its node's source range, so a match leads back to the exact lines.
- The parse that answers every edit computes the ids, and an unchanged block keeps its id.
- One walk over the overlays' trees, path by path, finds the suggestions: where the overlays' ids agree the walk stops, and where they differ it descends only as far as the differences.
- The table belongs to the stack and goes with it when the stack is evicted.

## Placeholders

A placeholder splices a value into a scalar or a key, whole or as part of a longer string.

| Field | Meaning |
|---|---|
| `pattern` | the placeholder, whose `body` group is what it holds |
| `unscanned_paths` | the paths whose text belongs to another language, such as shell commands or a Dockerfile, where `${…}` is not the DSL's and is not read; each entry has `path` and `skip_keys` |

- A body is read by the reference rules whose `positions` list a placeholder position: `${local.name}` holds `local.name`, read by a `local` rule, and `${env}` holds `env`, read by a rule in a logical scope such as `GLOBAL`.
- Every placeholder is validated. A body no rule reads, text after the name where the rule's `text_after_name_allowed` is `false`, and a position the rule does not list are problems.
- A valid body is classified like any other reference.

## Functions

`function` holds what is generic to calls:

| Field | Meaning |
|---|---|
| `call_result_reference_positions` | the positions from which a name a call declares may be referenced |
| `calls_not_allowed_at` | the paths where a call is a problem, each with `path` and `skip_keys` |
| `marker_function` | the one call shape modeled, below |
| `definitions` | the sources of the function table, merged in order |

`marker_function` is a call written in a key, `<name> <call_marker><function>`:

- `splat_operator` follows the function when the value below is a list of arguments rather than the one argument.
- `calls_without_name_allowed` says whether a key that is the marker alone is a call with no name, the only key of its map.

| `definitions` source | The table |
|---|---|
| `terraform` | the answer of `terraform metadata functions -json`, run by the language server and ignored when Terraform cannot be invoked |
| `schema` | the table the file's schema publishes at `#/x-yaml-dsl-functions`; a schema that publishes no table there, or a malformed one, is a problem on the modeline line |

- While a source has not answered the vocabulary is open, and an unknown function is a problem only once every source has.
- Every call is checked: its function against the vocabulary, its argument count against the function's arity, and each literal argument against its type. A reference or a call standing as an argument is not typed.
- Hover on a function shows its signature.

## The function table

A schema publishes a DSL's functions as a mapping of function name to its arguments in call order. The extension ships the table's JSON Schema at `schemas/x-yaml-dsl-functions.schema.json`.

| Argument field | Meaning |
|---|---|
| `name` | the argument's name |
| `type` | `text`, `number`, `whole_number`, `boolean`, `list`, `map` or `any` |
| `required` | whether it is required; optional arguments follow the required ones |
| `repeated` | whether it takes every remaining value; a repeated argument is last |

```json
"x-yaml-dsl-functions": {
  "format": [
    { "name": "layout", "type": "text", "required": true, "repeated": false },
    { "name": "operands", "type": "any", "required": false, "repeated": true }
  ]
}
```

Terraform's signatures are read into the same table:

| Terraform | Table |
|---|---|
| `string` | `text` |
| `bool` | `boolean` |
| a list, set or tuple | `list` |
| a map or object | `map` |
| `dynamic` | `any` |
| a variadic parameter | a repeated optional argument |

## What the workspace defines

One `yaml-dsl.yml` at the root of a workspace folder. The extension ships its JSON Schema at `schemas/yaml-dsl.schema.json`.

```yaml
version: "1"
dsls:
  - id: resource
    file_includes: ["**/resources.yml"]
    file_excludes: []
    schema_search_paths:
      - .terraform/modules/resources_yaml/resources.schema.json
      - dev/.terraform/modules/resources_yaml/resources.schema.json
    layers:
      overlay_folders: [dev, staging]
      common_layer_discovery: ancestor
      common_layer_files:
        resources.yml: ["{concern}.resources.yml", resources.yml]
      duplicate_check:
        depth: 2
        key_depths: {}
        skip_keys: [schema_version]
    placeholder:
      pattern: "\\$\\{(?<body>[^}\\n]*)\\}"
      unscanned_paths: []
    function:
      definitions: [terraform]
      call_result_reference_positions: [whole_scalar]
      calls_not_allowed_at:
        - { path: "$.*", skip_keys: [] }
        - { path: "$.cloud", skip_keys: [] }
        - { path: "$.cloud..*", skip_keys: [] }
      marker_function:
        call_marker: fn.
        splat_operator: "*"
        calls_without_name_allowed: true
    locals:
      scope_name: local
    key_sort_orders:
      - path: "$.locals"
        skip_keys: []
        order: alphabetical
        first_keys: []
        last_keys: []
      - path: "$..*"
        skip_keys: [locals]
        order: significance
        first_keys: []
        last_keys: []
      - path: "$"
        skip_keys: []
        order: significance
        first_keys: [schema_version, env, locals]
        last_keys: [data_source, outputs]
    scopes:
      GLOBAL:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [env, region]
      RESOURCE:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: true
        builtin_names: []
      local:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: []
    declarations:
      - path: "$.locals.*"
        skip_keys: []
        exclude_candidates: []
        name_source: key
        key_token: first_word
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: false
        scope_name: local
      - path: "$.*.*"
        skip_keys: [cloud, locals, outputs]
        exclude_candidates: []
        name_source: key
        key_token: last_word
        name_spelling: dashes_as_underscores
        meta_argument_name: null
        declares_every_name: false
        scope_name: RESOURCE
    references:
      - pattern: "^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_${}]+)"
        positions: [whole_scalar]
        text_after_name_allowed: true
        scope_name: RESOURCE
        scope_group: type
        name_group: name
      - pattern: "^local\\.(?<name>[a-z0-9_]+)$"
        positions: [whole_scalar, whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: local
        scope_group: null
        name_group: name
      - pattern: "^(?<name>[a-z_]+)$"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: GLOBAL
        scope_group: null
        name_group: name
  - id: pipeline
    file_includes: ["**/pipelines.yml"]
    file_excludes: []
    schema_search_paths:
      - .terraform/modules/pipelines/schema.json
    placeholder:
      pattern: "\\$\\{(?<body>[^}\\n]*)\\}"
      unscanned_paths:
        - { path: "$.build", skip_keys: [] }
        - { path: "$.build..*", skip_keys: [] }
    key_sort_orders: []
    scopes:
      BRANCH:
        regions: ["$.branches.deployment_target_env"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [branch]
      ENV_VAR_GLOBAL:
        regions: ["$.container.environment"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [ENVIRONMENT, VERSION]
      GLOBAL:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [env, region]
    declarations: []
    references:
      - pattern: "^(?<name>[a-z_]+)$"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: GLOBAL
        scope_group: null
        name_group: name
      - pattern: "^(?<name>[a-z_]+)$"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: BRANCH
        scope_group: null
        name_group: name
      - pattern: "^(?<name>[A-Z_]+)$"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: ENV_VAR_GLOBAL
        scope_group: null
        name_group: name
  - id: test
    file_includes: ["**/*.yml"]
    file_excludes: ["**/protocols/**"]
    schema_search_paths: []
    placeholder:
      pattern: "\\$\\{(?<body>[^}\\n]*)\\}"
      unscanned_paths: []
    function:
      definitions: [schema]
      call_result_reference_positions: [whole_placeholder, placeholder_in_text]
      calls_not_allowed_at: []
      marker_function:
        call_marker: fn.
        splat_operator: "*"
        calls_without_name_allowed: false
    locals:
      scope_name: local
    key_sort_orders: []
    scopes:
      GLOBAL:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: [env, region]
      local:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: []
      protocol:
        regions: ["$"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: []
      setup:
        regions: ["$.cases", "$.teardown"]
        later_items_of_declaring_list: false
        named_by_parent_key: false
        builtin_names: []
      step:
        regions: []
        later_items_of_declaring_list: true
        named_by_parent_key: false
        builtin_names: []
    declarations:
      - path: "$.cases[*].steps[*].*"
        skip_keys: []
        exclude_candidates: []
        name_source: meta_argument
        key_token: null
        name_spelling: as_written
        meta_argument_name: id
        declares_every_name: false
        scope_name: step
      - path: "$.locals.*"
        skip_keys: []
        exclude_candidates: []
        name_source: key
        key_token: first_word
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: false
        scope_name: local
      - path: "$.protocols.*.messages"
        skip_keys: []
        exclude_candidates: []
        name_source: key
        key_token: all_words
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: true
        scope_name: protocol
      - path: "$.setup[*].id"
        skip_keys: []
        exclude_candidates: []
        name_source: value
        key_token: null
        name_spelling: as_written
        meta_argument_name: null
        declares_every_name: false
        scope_name: setup
    references:
      - pattern: "^(?<name>[a-z_]+)$"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: GLOBAL
        scope_group: null
        name_group: name
      - pattern: "^local\\.(?<name>[a-z0-9_]+)$"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: false
        scope_name: local
        scope_group: null
        name_group: name
      - pattern: "(?<![A-Za-z0-9_./])protocol\\.(?<name>[a-z0-9_]+)"
        positions: [anywhere_in_scalar]
        text_after_name_allowed: true
        scope_name: protocol
        scope_group: null
        name_group: name
      - pattern: "^setup\\.(?<name>[a-z0-9_]+)"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: true
        scope_name: setup
        scope_group: null
        name_group: name
      - pattern: "^step\\.(?<name>[a-z0-9_]+)"
        positions: [whole_placeholder, placeholder_in_text]
        text_after_name_allowed: true
        scope_name: step
        scope_group: null
        name_group: name
```

- `version` is the config format, read by the reader of that version.
- A block left out is a feature the DSL does not have: `layers` is a DSL's composition of a common layer and its overlays, and a DSL without layers still formats, navigates and hovers.
- A file matching two DSLs is reported and claimed by neither. Other YAML is untouched.

## Ownership

- The extension contributes the language `yaml-dsl`.
- It starts only when a workspace folder holds `yaml-dsl.yml`, and leaves a folder without one alone, even in a window where another folder has one.
- When the workspace config loads, each DSL's files are associated with that language: those its `file_includes` globs or the `{concern}` names in its `layers.common_layer_files` match, and its `file_excludes` globs do not. Such a file opens as `yaml-dsl`, and the language server's document selector is that language.
- An extension that selects `yaml`, such as the Red Hat YAML extension, does not own these files and does not activate on them.
- A file that matches no DSL pattern stays `yaml`.

## Settings

- The extension's own settings are VS Code settings under the extension's name, `yaml-dsl-editor`.
- A setting is the user's choice of how the editor behaves, the same for every DSL. What a DSL is, and its syntax, lives in `yaml-dsl.yml`, never in a setting.
- Every cache the extension keeps is bounded, and each cache's capacity is a setting.
- Every behavior that nags has a setting that turns it off.
- A change to a setting applies at once.
- The README lists every setting.

## Out of scope

- Running the engine that accepts the file.
- A DSL's schema or definition shipped inside the extension.

## TODO

- A move turns list and map differences into locals, and on a tie the common layer declares a list's local as `[]` and a map's as `{}`.
- A local renamed in an overlay or the common layer, once the edit is done, gets a suggestion to rename it in every other file that declares or references it, as one multi-file edit.
- `yaml-dsl.yml` is claimed as the extension's own file type, "YAML DSL Config". The extension offers help on authoring this file.
- Find All References on a declaration lists every reference to it across the common layer and each overlay.

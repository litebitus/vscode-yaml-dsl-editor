# Changelog

## Unreleased

- Ownership: each config's globs are written to an existing workspace settings file's `files.associations`, so a DSL file opens as YAML DSL before another YAML extension can read it; a glob already associated, in any spelling, is not repeated.
- Config: a `yaml-dsl.yml` in any folder of the workspace governs the files below it, and `{config_root}/` starts a glob or schema path at its folder.
- Config: `tag_keys` reads a YAML tag as the key it stands for, so `!Ref Mock` and `Ref: Mock` are one reference, one field and one value.
- Hover, completion and required-field filling: a schema's `if`/`then`/`else` is read by the branch the document's value selects.
- Hover: with the document's value, a field's conditions are the branches the value selects, and a field's own `if` branch sets its shown type.
- Hover and completion: a field under an `anyOf` or `oneOf` is read through the alternatives whose type admits the document's value.
- Layers: `common_layer_discovery: overlay_includes` pairs an overlay with the common layers its includes name, each merged where its include sits.
- Paths: the JSONPath steps `['name']` and `..name`.
- Schemas: a modeline's `#` or `#/pointer` marks a fragment, validated at the node it names with no key required.
- Schemas: a `pattern` is built with the `u` flag, as JSON Schema says.
- Performance: choosing a branch, comparing overlays' schema nodes and checking an opt-out no longer each compile or hash a whole large schema.
- Performance: documents are validated in a worker, so a large schema's compile never holds hover, completion or suggestions.
- Functions: the function table states each function's and argument's description and the function's `return`, shown on hover, Terraform's included; a function mapped straight to its argument list is deprecated, noted by an info on the modeline.
- Functions: `splat_operator: null` lets the function table decide how a call's value binds its arguments; CloudFormation's functions are calls by `Fn::`, documented and checked from the table its schema publishes.
- Macros: a function table entry with a `macro` object is a macro, called beside sibling keys, after a name suffix its `name_suffix_pattern` matches, and documented by what it expands to; CloudFormation's `Fn::ForEach` is one.
- Macros: a `function_call` macro binds its arguments by name and its callee's arguments by name, documents its callee on hover, and is also called by a key at its `unmarked_key_paths`; CloudFormation's `Fn::Transform` and `Transform` section are one, and an include's key is a call of it.
- Macros: CloudFormation's `AWS::Include` is a `merge` macro, so an include's `Parameters` are checked against it and hover documents it.
- Macros: a `loop` macro declares its identifier in its body and each literal item's names where its body lands; each item is validated, documented and completed at that place, a problem naming the items it holds for; CloudFormation's placeholder pattern reads `&{…}` too.
- Hover: a function's or macro's signature is colored by its own grammar, the macro keyword, name, arguments and types each apart, never as the open file's YAML.
- Layers: a file an include's location maps to, written or removed after its overlay opened, is followed or left at once.
- Hover: a field's line shows its name and requirement as code and its type in italics; a definition that chooses between definitions is named by the one the value selects.
- Completion: a function or macro offered after its call marker is documented as its hover is, and a field a branch restates without a description keeps the description its base states.
- Functions: an argument or return typed `function` or `macro` holds the name of a table entry of that kind; a `function_call` macro's callee so typed is completed from those entries and checked against them.
- Macros: a `transform` macro takes the arguments its entry states and expands to the map holding the call, rewritten by the macro; a table entry's name may hold `-`.
- Examples: CloudFormation's function table holds the `Rules` section's functions and every transform AWS hosts.
- Hover and completion: a builtin reads `` `<name>`: *builtin* ``, no longer its scope's name.
- Examples: the CloudFormation schema names its definitions in the engine's words, `ref` apart from `func` and `condition_ref` apart from `condition_func`; `.vscodeignore` leaves dependencies' TypeScript sources, source maps and browser builds out of the package.
- Config: `validator.allow_quoted_values` validates a quoted boolean or number as the value it spells.
- Config: `performance.compiled_schema_cache` keeps a DSL's compiled schema in the extension's storage for later sessions.
- Examples: the CloudFormation schema, generated from AWS's resource provider schemas by `scripts/cloudformation-schema/`.
- Docs: the design doc and README speak of entries and a sample DSL, no longer of one DSL's resources.

## 0.7.0 - 2026-10-15

- Hover: fixed tooltips breaking lines in the middle of words.
- Hover: a field's tooltip documents it like a javadoc: its signature with the forms its references reach, its description in markdown, what it accepts, its constraints, its conditions and its parent's conditions that name it; in the common layer, one section per overlay schema that documents it differently.
- Hover: a field shows what its schema's dependencies require when it is set, and in the common layer, which overlays' schemas don't have the field.
- Validation: a field set without the fields its schema's dependencies require is now an error on that field saying what it needs.
- Hover: in the common layer, each section is headed by its overlays' names in a color of its own, for light and dark themes.
- Validation: a key's validation errors show in one hover under a colored heading, one bullet each.
- Themes: every color the extension draws comes from a dark or a light theme, which follows the editor's theme by default; `yaml-dsl-editor.theme` names it, and a title bar button switches the editor and the extension between light and dark together.
- Suggestions: in the light theme, a suggestion's gutter mark, inlay hint and Explorer badge show `✦` in the theme's suggestion color, where the light bulb emoji kept its own colors.
- Hover: a key that sets a field of its entry, by `child_values_from_parent_key`, also documents the field it sets.

### Deprecated

- Colors: `yamlDslEditor.errorForeground`, `warningForeground`, `infoForeground` and `overlayDiff.difference<n>`; use `yamlDslEditor.dark.<role>` and `yamlDslEditor.light.<role>`.

## 0.6.0 - 2026-10-15

- Schemas: JSON Schema draft-07, draft 2019-09 and draft 2020-12 are read, each by a parser named after it; a schema declaring no draft or an older one is read as draft-07, and one declaring any other draft is an info problem.
- Schemas: a deprecated field is a warning, in the drafts that define `deprecated`: its key is struck through in yellow, its message is the hover of its key and value, and its file and folders show in yellow with a `⚠` badge, kept across restarts and reported for stacks worked out in the background.
- Completion: keys and values complete from the file's schema: a map's fields, each with its requirement marker and description, deprecated ones struck through, and a field's `enum`, `const` and boolean values.
- Validation: each document is validated against its schema, an overlay as its fold, with the requirement markers deciding which fields are required, and each validation error marked on the key that wrote it.
- Config: a DSL's `validator` block states its `merge_base_keys` and `child_values_from_parent_key`, read only by validation.
- Validation: a field a call key of the DSL's `marker_function` supplies is not reported missing.
- Validation: an overlay's `{}` or `[]` opting out of a common layer key leaves that key out of the validated fold.
- Settings: `validator.enabled`, `validator.errorSeverity` and `validator.fileDecoration` turn validation errors off, set their severity, and color their files.
- Problems: every warning but a deprecation is underlined in yellow.
- Schemas: the schema path in a file's modeline is a link that opens the schema.
- Completion: word completion is off in DSL files.
- Completion: a scalar field with a schema `default` is written with the default selected, when completed and when filled as a required field.
- Problems: a key with no `:` yet is an error on that key once the cursor leaves its line, and the lines around it read as if it were not there.
- Problems: a key its map holds twice is a warning on each copy naming the other's line, where it was a parse error.
- Completion: in a DSL file, Tab and Shift+Tab move through the list, Tab accepts a lone entry, and Enter accepts.
- Completion: Enter after a key whose map is empty fills the map's required fields, the cursor at the first value and Tab moving between them.
- Schemas: the shipped `yaml-dsl.schema.json` and `x-yaml-dsl-functions.schema.json` are draft 2020-12.
- Problems: a warning carries a yellow triangle in the gutter.
- Renaming: "rename everywhere" takes the hand edit back, reverting an unsaved one or undoing and saving a saved one, then renames and saves every file, so one undo takes them all back.
- Suggestions: kept suggestions are worked out again when the schema their file reads changes, at startup and when the schema changes on disk.
- Suggestions: the folders above a file holding a suggestion show the light bulb color over source control's.
- Settings: `warning.deprecation.enabled` and `warning.deprecation.fileDecoration` turn deprecation warnings, or only their file and folder decorations, off.
- Settings: `suggestion.<kind>.enabled` and `suggestion.<kind>.fileDecoration` turn each kind of suggestion, or only its file and folder decorations, off.

### Deprecated

- Settings: `features.suggestions`; use `suggestion.<kind>.enabled`.

## 0.5.3 - 2026-10-14

- Overlay diff: the diff button shows on every DSL file, and with nothing selected diffs the key on the cursor's line.
- Overlay diff: fixed choosing overlays opening a second diff view; it now updates the open one.

## 0.5.2 - 2026-10-14

- Suggestions: undoing a move that created a common layer file no longer tries to save the removed file.

## 0.5.1 - 2026-10-14

- Suggestions: a move or a delete carries the comment above each key it deletes or writes, and each map a move opens.
- Suggestions: a concern's new common layer holds only the fallback's blocks its references reach.

## 0.5.0 - 2026-10-14

- Layers: `layers.common_layer_files` lists the names a common layer may take, so a concern below its overlays can have its own, which discovery and moves prefer.
- Suggestions: the move link names the common layer file it writes into, `new` when the move creates it.
- Overlay diff: a title-bar button on selected lines opens a read-only view of how the overlays differ, which follows the selection.

## 0.4.1 - 2026-10-13

- Suggestions: a value most overlays repeat under a map the common layer lacks moves, opening the map, and combines with the moves beside it.
- Suggestions: saved suggestions another build of the extension worked out are not shown, and their stacks are worked out again.
- Output: startup logs the build of the extension it runs.
- Suggestions: saving a file keeps its suggestions, where the save hid them until the next edit.
- Suggestions: a move takes one unit whole, placed by `duplicate_check.depth` and `key_depths`, so no unit is split between the common layer and an overlay.
- Suggestions: a unit with one difference is a potential move that keeps its link, and a unit with more is not offered.
- Suggestions: an overlay lacking a list or map opts out with `[]` or `{}`, and one lacking a scalar takes its schema's default.
- Suggestions: a difference holding a list or map is written as a local declared on the lines below its name.
- Suggestions: moves of neighboring keys in one map combine into one move that keeps the overlays' order.
- Suggestions: a border marks the lines a suggestion takes while the cursor is on its light bulb line.
- Layers: a layer file deleted from disk leaves its stack even while its tab is open, unless it holds unsaved edits.
- Layers: closing a layer file's tab reads it from disk again.

## 0.4.0 - 2026-10-09

- Renaming: Rename Symbol renames a name in every layer's declaration and every reference of the stack.
- Suggestions: a name edited by hand, while the stack still uses the old one, gets a hint renaming it everywhere.
- Suggestions: a potential move shows as information, with the info gutter mark and an `ⓘ` hint, and colors no file or folder.

## 0.3.0 - 2026-10-09

- Suggestions: a stack with no common layer file gets the moves that create it.
- Suggestions: a local is named by the block's key and the nearest named key above the value, leaving out declared names, calls and list items.
- Suggestions: clicking the link in a suggestion's hover dismisses the hover.
- Suggestions: inlay hints come back after an edit or a move, where the editor stopped asking once a file had none.
- References: a common layer reference resolves in each overlay whose merge keeps it, and Command-click on one reaching several declarations shows each, headed by its overlay.
- References: resting the pointer on a reference that names a declaration opens no popup.
- Output: the YAML DSL channel logs each startup step, the first analysis of each opened file and every failure; a failed startup step no longer keeps the language server from starting.

## 0.2.0 - 2026-10-08

- Locals: `locals.scope_name` names the scope whose declarations are a DSL's locals, resolved recursively in each fold, with hover showing a local's value and a cycle reported as a problem.
- Suggestions: a block most overlays hold gets a gutter light bulb and an inlay hint that moves it into the common layer, each difference written as a local.
- Suggestions: a move is offered only when the overlays' schemas agree at the block and each opt-out passes them; otherwise the hint is a potential move with the schema's messages.
- Suggestions: a key an overlay holds the same as the common layer, within `layers.duplicate_check`, gets a suggestion to delete it.
- Suggestions: a value most overlays repeat, within `layers.duplicate_check` and locals included, moves into the common layer over the value it held there.
- Suggestions: applying one saves every file it changed.
- Suggestions: undoing or redoing an applied suggestion saves every file it brings back.
- Suggestions: a stack loaded again after leaving the cache works its suggestions out without waiting for an edit, and a failure to work them out is logged instead of stopping the server.
- Suggestions: kept in the extension's global storage per workspace and file, with the hash of the text they came from, so they survive a stack leaving the cache and an editor restart; a file changed outside the editor has its stack worked out again.
- Work queue: the active file's work starts at once, ahead of a background job in progress.
- Cache: a stack with a file in an open editor is never evicted; open editors' work, suggestions included, runs before any background work.
- Startup: a file shows at once, colored and underlined from its text, then the saved suggestions, then analysis in the background; a stack is analyzed only once a file of it is opened.
- Suggestions: a file holding one shows its name in the light bulb's color with a 💡 badge in the Explorer and on its tab, and every folder above it takes the color.
- Requirement markers: a field's marker decides requiredness over its parent's `required` array, and an opt-out leaving out a `[~required]` field is a potential move the user may still apply.
- Key sort orders: `key_sort_orders` sets where a suggestion places a new key, `alphabetical` or `significance`, per map.
- Suggestions: a new key takes the blank lines around it in the first overlay holding it.
- Key sort orders: an entry states `first_keys` and `last_keys`, the keys a `significance` map keeps at its top and bottom.
- Paths: every config path is a JSONPath (RFC 9535) with `$`, `.name`, `.*`, `[*]` and a final `..*`; `.*` and `[*]` select the children of a map or a list alike, and a path appears once per list.
- Layers: a layer file that changes on disk is read again.
- Folding: an overlay's empty map replaces the common layer's entry in a folded document, at any depth.
- Config: a config change reaches every loaded stack, and a workspace folder added or removed reloads the configs.
- Settings: `yaml-dsl-editor.features.suggestions` turns suggestions on or off.
- Settings: `yaml-dsl-editor.cache.stackCapacity` and `yaml-dsl-editor.cache.schemaCapacity` bound the stack and schema caches, least recently used first.
- Problems: a line with an error carries a gutter mark.
- Problems: a schema that cannot be loaded is an info problem, a wavy underline and a gutter mark in the blue the DevOps tools print info in.
- Problems: errors take the red the DevOps tools print failures in.
- Problems: a YAML parse error marks the line it is on, where it used to mark the first line.
- Hover: a reference nothing declares reads `Invalid reference: <scope>.<name>`.
- Inlay hints: on in DSL files, where an editor such as Antigravity defaults them to off.
- Inlay hints: DSL files set `editor.inlayHints.maximumLength`, so a suggestion's label is not truncated at the editor's default.

### Deprecated

- `yaml-dsl.yml`: `includes_subtree` on `unscanned_paths` and `calls_not_allowed_at`; list the path ending in `..*` as its own entry.

## 0.1.0

- `yaml-dsl.yml` is versioned, `version: "1"`, with explicit single-type fields, and ships its JSON Schema.
- A declaration rule can declare every name of a scope at one key.
- The common layer is found by `layers.common_layer_discovery`, and a reference resolves in its file's own fold, the overlay first.
- Scopes, visibility and functions are declared per DSL, and calls are checked against Terraform's and the schema's function tables.
- References and placeholders complete and validate from each DSL's config, and are marked by underline shape.
- Problems show as squiggles, and a schema that changes on disk is reloaded.
- The active file is analyzed ahead of all other work.

## 0.0.2

- The YAML DSL language server: hover from the schema as authored, navigation of references, folded overlay documents and stack-scoped analysis.
- A file is claimed only from its own folder's `yaml-dsl.yml`, and only the changed file is re-parsed.
- Makefile target to install into Antigravity.

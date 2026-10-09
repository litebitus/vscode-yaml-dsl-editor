# Changelog

## Unreleased

- Suggestions: a stack with no common layer file gets the moves that create it.
- Suggestions: a local is named by the block's key and the nearest named key above the value, leaving out declared names, calls and list items.
- Suggestions: clicking the link in a suggestion's hover dismisses the hover.
- Suggestions: inlay hints come back after an edit or a move, where the editor stopped asking once a file had none.
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

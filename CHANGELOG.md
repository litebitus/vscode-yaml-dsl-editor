# Changelog

## Unreleased

- Locals: `locals.scope_name` names the scope whose declarations are a DSL's locals, resolved recursively in each fold, with hover showing a local's value and a cycle reported as a problem.
- Suggestions: a block most overlays hold gets a gutter light bulb and an inlay hint that moves it into the common layer, each difference written as a local.
- Suggestions: a move is offered only when the overlays' schemas agree at the block and each opt-out passes them; otherwise the hint is a potential move with the schema's messages.
- Requirement markers decide requiredness over a parent's `required` array, and an opt-out leaving out a `[~required]` field is a potential move the user may still apply.
- Suggestions: a key an overlay holds the same as the common layer, within `layers.duplicate_check`, gets a suggestion to delete it.
- `key_orders` sets where a suggestion places a new key, `alphabetical` or `significance`, per map.
- Applying a suggestion saves every file it changed.
- A layer file that changes on disk is read again.
- A config change reaches every loaded stack, and a workspace folder added or removed reloads the configs.
- Setting `yaml-dsl-editor.features.suggestions` turns suggestions on or off.
- Settings `yaml-dsl-editor.cache.stackCapacity` and `yaml-dsl-editor.cache.schemaCapacity` bound the stack and schema caches, least recently used first.
- A line with an error carries a gutter mark.
- Inlay hints are on in DSL files, where an editor such as Antigravity defaults them to off.
- An overlay's empty map replaces the common layer's entry in a folded document, at any depth.

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

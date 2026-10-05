# YAML DSL editor

Authoring `sample.yml` is hard without this extension, and that is why it exists. A stack is a common layer and an overlay per environment. The file on screen is one of those, not the environment's full config. A field's documentation sits beside a `$ref` the usual YAML tooling never reads. A `ref` and a `local` are strings, so nothing jumps to the declaration. The extension is the editor that makes that document authorable.

The extension is generic. Any DSL written this way is a block in the workspace config, `yaml-dsl.yml`. Nothing about a particular DSL is compiled into the extension. The block says which files belong, the syntax of a ref and of a local, when the DSL has layers which directories are environments, and a fallback schema for a document that does not name one. A ref and a local are generic: the editor navigates them and hovers them the same way in every DSL. Each DSL's block supplies the syntax that declares them, and those syntaxes differ.

`sample.yml` is the DSL this document works through. Its field types are shared definitions, because a value may be a scalar, a `ref`, or a bare `local`. A simpler DSL uses the same engine through its own config block. The first config block, and the first files the editor is proven against, are `sample.yml`.

Features are fine-tuned iteratively. The first slice is what any editor for a programming language provides: hover documentation, and navigation of refs and locals. Diffing environments, suggestions, and extraction into the common layer come after that slice and are tuned the same way.

## Language server

The editor is a language server. It has to be. Activating any `sample.yml` puts the whole stack in scope: the common layer and every adjacent overlay. The server holds that context. Switching from one file in the stack to another uses it. Rebuilding the stack on each switch would be slow.

The server keeps the stack current as the files change, including the folded document of each environment. Those folded documents are buffers in the editor view, so the author sees an environment's full config instead of assembling it from the files. Hover and navigation run against the stack in scope, not against the active file alone.

On each change the server parses the changed YAML, reads that file's schema, and resolves refs and locals across the stack. Hover and navigation are requests against that analysis. Later diagnostics and suggestions are further results of the same pass.

The workspace holds many stacks. The server loads one when a file in it becomes active, and does not load the rest at startup. A resident stack is the parsed common layer, every adjacent overlay, the symbol index, and the folded document of each environment. Switching files inside a resident stack is a hit.

The cache is bounded, and the unit is the stack. The stack of the active editor is pinned, and so is any stack whose folded buffer is on screen. A pin is not an eviction candidate. Opening, editing, navigating into, or showing a stack marks it most recently used. Capacity beyond the pins is 8 stacks. Loading one past that evicts the least recently used unpinned stack: its analysis is dropped and its folded buffers close. The files on disk stay. The next activation loads that stack again. A change to a resident stack updates it in place.

A stack's schema is the `schema.json` of the grammar version that stack initialized. The same grammar version is the same schema, so every stack on that version shares one parsed copy. A different grammar version is a different schema, even when the difference is small, and hover for a stack uses the schema of its own version. The server keeps every distinct schema for the life of the workspace. Evicting a stack drops its layers and folded documents, not the schema.

The server does not run the engine. The continuous compile is the editor's analysis. Plan and admission stay with the engine.

The extension process is the client. The analysis is a plain module with no editor API in it, so it is tested on its own with `node --test`. Editor features stay in the language server from the start.

Line coverage and branch coverage of the extension's own code are each at least 90%. The `node --test` run measures both and fails if either is under that. Test files are not part of the measured set.

## Common layer and overlays

The core of a layered DSL is how a stack is composed. One `sample.yml` is the common layer. Each environment is an overlay: a `sample.yml` in a directory named `one` or `two` beside that file. The engine deep-merges the common layer under the overlay, and the folded document is what a plan sees. The same shape without an instance directory (`mock-family/sample.yml` beside `mock-family/one/`) is the same composition.

```
mock-stack/sample.yml
mock-stack/one/sample.yml
mock-stack/two/sample.yml
mock-stack/three/sample.yml
mock-stack/four/sample.yml
```

An author editing one of those files sees only that file. The language server buffers the stack in the editor view: each environment's folded document, common layer merged with that overlay. Shared config lives in the common layer, including a local that a resource references. The `layers` block in the config is this composition.

While any file in the stack is active, refs and locals resolve across the common layer and every adjacent overlay. Across environments, the editor diffs the folded documents. A block repeated in every overlay is one edit away from drifting: the next change lands in a single environment and the others keep the old copy. The editor suggests moving that block into the common layer, and one click applies it.

## Formatting

Claimed files have a document formatter. It changes indentation and whitespace. Comments, key order, and the spelling of scalars stay, so a format pass does not rewrite a `ref`, a `local`, or a `${...}` placeholder into a different string.

## Navigating refs

Go to definition on a ref opens the declaration it names. The editor has one navigation behavior. The config's reference rule is the syntax: which scalars are refs, and which symbol they point at.

In `sample.yml` that syntax is a whole scalar `ref <type>.<name>`, with an optional field path after the name. The field path is not a separate target. Navigation opens the resource `<name>` under `<type>`.

The resource's identity is the last token of its key, with `-` written as `_`. A key `name mock-thing-v2` is the ref name `mock_thing_v2`. A logical key `primary` is the ref name `primary`. A `${...}` placeholder is compared as written. The editor does not substitute it. When nothing in scope matches, go to definition does not move.

Scope for a ref is the active stack: the common layer and every adjacent overlay. A ref in one file may name a resource declared in another file of that stack.

## Locals

A local is a named value declared in the document. Go to definition opens that declaration. Hover shows the value as authored. Scope is the active stack, the same as a ref.

`sample.yml` declares locals as keys under `locals`, and references them as a whole scalar `local.<name>` or as `${local.<name>}` inside a scalar. Another DSL declares the same concept with its own syntax in its own config block. A value shared by resources is a local in the common layer, and each resource that uses it references the local.

## Hover documentation

The Red Hat YAML extension is not used. It resolves a field to the schema node a draft-07 validator sees, and for these DSLs that node is a shared value definition.

A field's value `$ref`s a composite such as `string_or_ref` or `string_list_or_ref`, because the value may be a scalar, a `ref`, or a bare `local`. The field's own documentation is written beside that `$ref`. Draft-07 ignores every keyword beside a `$ref`, so a compliant hover follows the reference and shows the composite's text — "a literal string, a `ref`, or a bare `local`" — and the field text is never read:

```json
"label": {
  "$ref": "#/definitions/string_or_ref",
  "description": "[required] Mock label for the thing (or `ref`)."
}
```

A schema for this kind of value is built this way.

This extension reads the schema document as authored. Hover walks the YAML path through `properties`, then `patternProperties`, then `additionalProperties`. On an object that carries both a `$ref` and a `description`, it keeps that `description`, then follows the `$ref` only to keep walking. The tooltip is the description kept at the field, requirement marker included (`[required]`, `[~required]`, `[optional]`). The composite's description is the value shape and is not the tooltip.

Hover on a ref shows the target's type, identity, and file. Hover on a local shows the value as authored.

The schema for a file is the one the file names. A `# yaml-language-server: $schema=` modeline is honored. Its path is relative to that file and points at the schema shipped with the grammar version the stack has initialized. An environment file names `.schema/sample.schema.json`. A common layer names that file through the environment directory that initialized the stack, such as `one/.schema/sample.schema.json`. That is the grammar the stack is actually on.

The config may set `schema` to a search path. It is the fallback, used when the file has no modeline or the path it names is not on disk. Each entry is relative to the file, the same way a modeline path is, and the first one on disk is the schema. A URL in the path is fetched. The search does not override a modeline that resolves. The extension embeds no schema. When neither source resolves, the file gets one diagnostic and field hovers stay empty.

DSL-level behavior is configured in `yaml-dsl.yml`: which files, the syntax of a ref, the syntax of a local, how layers are grouped. The concepts are the editor's. The syntax is the DSL's, and each DSL may spell it differently. That syntax does not move into the schema.

The schema is how the editor understands a field and the shape of an object: which keys exist, what value shape a key takes, and the field's own description, including the text beside a `$ref`. It is read as published. If that is not enough to understand a field or a shape, the schema gains an extension point and the grammar publishes it. The extension does not grow a special case for that object. No such point is added before a field or a shape actually requires one.

The schema is not the engine's checks. Those run at plan, after the fold. A check can require a group of fields only when another field has a certain value, allow a field for only one mode, or allow exactly one of two fields. The published schema has no such table. A field may be filled from the common layer, and the editor is looking at one file, so a `required` array on the resource alone does not say whether the folded document is complete. The common layer merged under the overlay remains. An extension point is not a transcription of these checks.

## Diffing across environments

The command opens the stack's environments together. Each entry is that environment's folded document: the common layer merged with the environment file by the same deep merge the engine uses. A path whose folded value is the same in every environment is quiet. A path whose folded value differs is the diff. An environment with no file is an empty overlay on the common layer, not a missing stack.

## Suggestions

The extension suggests an edit where it can see one. One click applies it. Extraction into the common layer is one such suggestion.

## Extracting the common layer

A block that every environment overlay states for itself will drift. The next edit changes one environment, and the others keep the old copy. Extraction puts that block in the common layer so the stack has one copy.

When every environment overlay sets a path to the same value, and moving that value into the common layer leaves every folded document unchanged, the editor suggests the extraction on that path. One click writes it to the common layer and removes it from each overlay.

- The common layer has no value at that path: the click writes the value there and deletes it from each overlay.
- The common layer already has that same value: the click deletes it from each overlay.
- Any environment disagrees, or an overlay does not set the path: the editor makes no suggestion.

Folded documents before and after the click are the same.

## What the workspace defines

One `yaml-dsl.yml` at the root of a workspace folder.

```yaml
dsls:
  - id: resources
    match: ["**/sample.yml"]
    schema:
      - .schema/sample.schema.json
      - one/.schema/sample.schema.json
    layers:
      environments: [one, two]
    symbols:
      - kind: local
        at: "$.locals.*"
        name: { from: key }
      - kind: resource
        at: "$.*.*"
        skip: [note, meta, locals]
        exclude: [skipme]
        name: { from: key, token: last, spelling: snake }
        qualify: { type: parent }
    references:
      - pattern: "^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_${}]+)"
        where: whole
        target: { kind: resource, type: type, name: name }
      - pattern: "^local\\.(?<name>[a-z0-9_]+)$"
        where: whole
        target: { kind: local, name: name }
      - pattern: "\\$\\{local\\.(?<name>[a-z0-9_]+)\\}"
        where: within
        target: { kind: local, name: name }
```

`layers` is a DSL's composition of a common layer and per-environment overlays. A DSL without it still formats, navigates, and hovers.

A file matching two DSLs is reported and claimed by neither. Other YAML is untouched.

## Ownership

The extension contributes the language `yaml-dsl`. When the workspace config loads, each DSL `match` pattern is associated with that language. A matching file opens as `yaml-dsl`, and the language server's document selector is that language.

An extension that selects `yaml` does not own these files and does not activate on them. The Red Hat YAML extension is one of those. A file that matches no DSL pattern stays `yaml`.

`at` is `$`, `.key`, `.*`, and `[*]`. `skip` lists keys a `.*` step does not descend into. `exclude` lists keys that are not symbols. `token: last` takes the key's last whitespace-separated token. `spelling: snake` writes `-` as `_`. `qualify.type: parent` is the mapping key that contains the symbol, and the reference's `type` group must equal it.

`where: whole` means the scalar is the reference. `where: within` means each match inside the scalar is a reference.

## Out of scope

- Running the engine that accepts the file.
- Diagnosing engine checks. Requiredness after the fold, fields that depend on another field, mutual exclusion, and checks on a derived value run in the engine at plan.
- Substituting `${...}`.
- Schemas or DSL definitions shipped inside the extension.

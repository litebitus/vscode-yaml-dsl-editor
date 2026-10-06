# YAML DSL editor

Authoring `sample.yml` is hard without this extension, and that is why it exists. A stack is a common layer and an overlay per environment. The file on screen is one of those, not the environment's full config. A field's documentation sits beside a `$ref` the usual YAML tooling never reads. A `ref` and a `local` are strings, so nothing jumps to the declaration. The extension is the editor that makes that document authorable.

The extension is generic. Any DSL written this way is a block in the workspace config, `yaml-dsl.yml`. Nothing about a particular DSL is compiled into the extension, and the config states every rule: the extension has no defaults, because every DSL is different. The block says which files belong, the DSL's scopes, where names are declared and how they are referenced, its placeholders and functions, when the DSL has layers which directories are environments, and a fallback schema for a document that does not name one. Scopes, references, placeholders and calls are generic: the editor validates, navigates, completes and hovers them the same way in every DSL. Each DSL's block supplies the syntax, and those syntaxes differ.

`sample.yml` is the DSL this document works through. Its field types are shared definitions, because a value may be a scalar, a `ref`, or a bare `local`. A simpler DSL uses the same engine through its own config block. The first config block, and the first files the editor is proven against, are `sample.yml`.

Features are fine-tuned iteratively. The first slice is what any editor for a programming language provides: hover documentation, and navigation of refs and locals. Diffing environments, suggestions, and extraction into the common layer come after that slice and are tuned the same way.

## Language server

The editor is a language server. It has to be. Activating any `sample.yml` puts the whole stack in scope: the common layer and every adjacent overlay. The server holds that context. Switching from one file in the stack to another uses it. Rebuilding the stack on each switch would be slow.

The server keeps the stack current as the files change, including the folded document of each environment. Those folded documents are buffers in the editor view, so the author sees an environment's full config instead of assembling it from the files. Hover and navigation run against the stack in scope, not against the active file alone.

On each change the server parses the changed YAML, reads that file's schema, and resolves references, placeholders and calls across the stack. Hover and navigation are requests against that analysis. Problems and later suggestions are further results of the same pass. A problem is red text with a red squiggle at its range, with its message on hover, and an empty range covers its whole line.

The workspace holds many stacks. The server loads one when a file in it becomes active, and does not load the rest at startup. A resident stack is the parsed common layer, every adjacent overlay, the symbol index, and the folded document of each environment. Switching files inside a resident stack is a hit.

The file in the active editor is worked on right away, ahead of all other files. Work on its stack goes first, the stacks of other open files next, and loading in the background last. A request about a file is answered once that file's analysis is done.

The cache is bounded, and the unit is the stack. The stack of the active editor is pinned, and so is any stack whose folded buffer is on screen. A pin is not an eviction candidate. Opening, editing, navigating into, or showing a stack marks it most recently used. Capacity beyond the pins is 8 stacks. Loading one past that evicts the least recently used unpinned stack: its analysis is dropped and its folded buffers close. The files on disk stay. The next activation loads that stack again. A change to a resident stack updates it in place.

A stack's schema is the `schema.json` of the grammar version that stack initialized. The same grammar version is the same schema, so every stack on that version shares one parsed copy. A different grammar version is a different schema, even when the difference is small, and hover for a stack uses the schema of its own version. The server keeps every distinct schema for the life of the workspace. Evicting a stack drops its layers and folded documents, not the schema.

A schema on disk changes when its stack is initialized again. The server watches every path a resident file's schema search reads, and any change at one of them reloads that file's schema. Bytes identical to a schema the server holds are that schema and are not parsed again.

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

## Scopes

A DSL is a language, and its names live in scopes. A scope says where its names may be referenced from: `visible_from` is `stack`, every file of the stack; `everywhere`; `following`, the later items of the list that declares the name, at any depth inside them; or a list of paths, the subtrees at those paths in the declaring file. A scope may list `names`, the builtins it holds. A global scope is one whose builtins are visible everywhere. Every scope a rule names is declared under `scopes`.

A symbol rule says where names are declared. `at` is the path: `$`, `.key`, `.*` and `[*]`. `skip` lists keys a `.*` step does not descend into, and `exclude` lists keys that are not symbols. `name.from` reads the name from the `key`, from the scalar `value`, or from a `meta_argument` of a key such as `http(id=config)`, one name per listed id. A key name takes its whole text, or its `first` or `last` whitespace-separated `token`, in the `spelling` `as_written` or `snake`, which writes `-` as `_`. `scope` is a scope name, or `{ from: parent, visible_from }`, where the mapping key enclosing the symbol names its scope.

A reference rule says how names are used. `pattern` is a regular expression with named groups. `where` lists the positions a reference may stand in: `whole`, the scalar; `placeholder`, a placeholder that is the whole scalar; `placeholder_in_string`, a placeholder inside longer text; `within`, each match inside a scalar. `trailing_text` is `none` or `any`, whether text such as a field path may follow the name. `target.scope` is a scope name, or `{ group }`, the pattern group holding a parent-derived scope. `target.name` is the group holding the name.

A reference resolves to a builtin of its target scope, else to a symbol of that scope, with that name, visible from the reference. A name that holds a placeholder whose value is a scalar is also known by that value, spelled by its symbol rule: a key `name ${local.thing}` whose local is `mock-thing` is the name `mock_thing`. The value is the one the file's fold sees. When the same symbol is in more than one file, the common layer wins, then the active file, then the other files in path order.

## Navigating references

Go to definition on a reference opens the declaration it names. Hover shows a scalar declaration's value as authored, and any other declaration's scope, name and file with its section. A builtin has no declaration. When nothing visible matches, go to definition does not move.

In `sample.yml` a ref is a whole scalar `ref <type>.<name>`, with an optional field path after the name. Its scope is `<type>`, the mapping key enclosing the resource. A local is a key under `locals`, referenced as a whole scalar `local.<name>` or as `${local.<name>}` inside a scalar. A value shared by resources is a local in the common layer.

The analysis classifies every reference: local when it resolves in the same file, external when it resolves in another file of the stack, error when nothing visible matches. The editor underlines each reference from the text as soon as the file opens, using the config's reference rules, and redraws it by its class once the analysis answers: a local reference keeps a straight underline and an external one is a squiggle, both in the text's own colors. An error turns red, text and squiggle. The whole reference takes its class's underline, placeholders inside it included.

The editor colors references, placeholders and calls from the config: a reference rule's leading literal, its target groups and its other literal text, a placeholder's delimiters and builtin body, and a call's marker, function and splat. The grammar colors plain YAML only. A `#` starts a comment only at the start of a line or after whitespace.

## Completion

Typing the start of a reference opens the list of what it can name. Each config reference rule is a literal with named groups, and the editor turns it into a template: `^ref (?<type>…)\.(?<name>…)` writes `ref <type>.<name>`. A symbol fills the template, and the result is kept only when the rule's own pattern reads it back as that symbol. A rule whose pattern is not a literal with named groups offers nothing.

The list holds what the file's fold sees and what is visible from the cursor. An overlay offers the common layer's symbols and its own. The common layer offers its own symbols and those declared in every overlay. A resource keyed by a local is offered under the local's value, the spelling a ref uses for it. A ref completes up to the resource name, and the field path after it is the author's. Inside a placeholder the list holds every reference a placeholder body may be, builtins included. After a call marker in a key, the list holds the vocabulary, each entry with its signature.

The list opens as the reference starts and narrows on every character, by the editor's fuzzy match against everything typed since the reference began. Each entry names the declaring file and shows the declaration as authored.

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

The schema for a file is the one the file names. A `# yaml-language-server: $schema=` modeline is honored. Its path is relative to that file and points at the schema shipped with the grammar version the stack has initialized. An environment file names `.schema/sample.schema.json`. A common layer names that file through the environment directory that initialized the stack, such as `one/.schema/sample.schema.json`. That is the grammar the stack is actually on.

The config may set `schema` to a search path. It is the fallback, used when the file has no modeline or the path it names is not on disk. Each entry is relative to the file, the same way a modeline path is, and the first one on disk is the schema. A URL in the path is fetched. The search does not override a modeline that resolves. The extension embeds no schema. When neither source resolves, the file's modeline line gets a problem, or its first line when it has no modeline, and field hovers stay empty.

DSL-level behavior is configured in `yaml-dsl.yml`: which files, the scopes, the syntax of declarations, references, placeholders and calls, how layers are grouped. The concepts are the editor's. The syntax is the DSL's, and each DSL may spell it differently. That syntax does not move into the schema.

The schema is how the editor understands a field and the shape of an object: which keys exist, what value shape a key takes, and the field's own description, including the text beside a `$ref`. It is read as published. If that is not enough to understand a field or a shape, the schema gains an extension point and the grammar publishes it. The extension does not grow a special case for that object. No such point is added before a field or a shape actually requires one.

The schema is not the engine's checks. The editor handles everything about authoring the DSL files, and those checks are a separate pass. A check can require a group of fields only when another field has a certain value, allow a field for only one mode, or allow exactly one of two fields. The published schema has no such table. A field may be filled from the common layer, and the editor is looking at one file, so a `required` array on the resource alone does not say whether the folded document is complete. The common layer merged under the overlay remains. An extension point is not a transcription of these checks.

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

## Placeholders

A placeholder splices a value into a scalar or a key, whole or as part of a longer string. `placeholders` is `none`, or a `pattern` whose `body` group is what the placeholder holds. A body is read by the reference rules whose `where` lists a placeholder position, so `${local.name}` holds `local.name`, read by a `local` rule, and `${env}` holds `env`, read by a rule targeting the global scope.

Every placeholder is validated. A body no rule reads, text after the name where the rule's `trailing_text` is `none`, and a position the rule does not list are problems. A valid body is classified like any other reference.

## Functions

`functions` is `none`, or the DSL's call grammar. A call is written in a key, `<name> <marker><function>`, with `splat` after the function when the value below is a list of arguments rather than the one argument. `unnamed_calls` is `sole_key`, a key that is the marker alone being a call with no name and the only key of its map, or `refused`. `call_results_where` lists the positions from which a symbol a call declares may be referenced. `refused_at` lists the paths where a call key is a problem, each with `at`, `skip`, and `subtree`, whether everything below the path is refused too.

`vocabulary` lists the sources of the function table, merged in order. `terraform` is the answer of `terraform metadata functions -json`, run by the language server and ignored when Terraform cannot be invoked. `{ schema: "#/<pointer>" }` is the table the file's schema publishes at that JSON pointer. While a source has not answered the vocabulary is open, and an unknown function is a problem only once every source has. A schema that publishes no table at the pointer, or a malformed one, is a problem on the modeline line.

Every call is checked: its function against the vocabulary, its argument count against the function's arity, and each literal argument against its type. A reference or a call standing as an argument is not typed. Hover on a function shows its signature.

## The function table

A schema publishes a DSL's functions as a mapping of function name to its arguments in call order. Each argument has a `name`, a `type`, whether it is `required`, and whether it is `repeated`, taking every remaining value. Optional arguments follow the required ones, and a repeated argument is last. `type` is `text`, `number`, `whole_number`, `boolean`, `list`, `map` or `any`. The extension ships the table's JSON Schema at `schemas/x-yaml-dsl-functions.schema.json`.

```json
"x-yaml-dsl-functions": {
  "format": [
    { "name": "layout", "type": "text", "required": true, "repeated": false },
    { "name": "operands", "type": "any", "required": false, "repeated": true }
  ]
}
```

Terraform's signatures are read into the same table: `string` is `text`, `bool` is `boolean`, a list, set or tuple is `list`, a map or object is `map`, `dynamic` is `any`, and a variadic parameter is a repeated optional argument.

## What the workspace defines

One `yaml-dsl.yml` at the root of a workspace folder.

```yaml
dsls:
  - id: resources
    includes: ["**/sample.yml"]
    excludes: ["**/.github/**"]
    schema:
      - .schema/sample.schema.json
      - one/.schema/sample.schema.json
    layers:
      environments: [one, two]
    placeholders:
      pattern: "\\$\\{(?<body>[^}\\n]*)\\}"
    functions:
      marker: fn.
      splat: "*"
      vocabulary: [terraform, { schema: "#/x-yaml-dsl-functions" }]
      unnamed_calls: sole_key
      call_results_where: [whole]
      refused_at:
        - { at: "$.*", skip: [], subtree: false }
        - { at: "$.meta", skip: [], subtree: true }
    scopes:
      global: { visible_from: everywhere, names: [env, region] }
      local: { visible_from: stack }
    symbols:
      - at: "$.locals.*"
        skip: []
        exclude: []
        name: { from: key, token: first, spelling: as_written }
        scope: local
      - at: "$.*.*"
        skip: [note, meta, locals]
        exclude: [skipme]
        name: { from: key, token: last, spelling: snake }
        scope: { from: parent, visible_from: stack }
    references:
      - pattern: "^ref (?<type>[a-z0-9_]+)\\.(?<name>[a-z0-9_${}]+)"
        where: [whole]
        trailing_text: any
        target: { scope: { group: type }, name: name }
      - pattern: "^local\\.(?<name>[a-z0-9_]+)$"
        where: [whole, placeholder, placeholder_in_string]
        trailing_text: none
        target: { scope: local, name: name }
      - pattern: "^(?<name>[a-z_]+)$"
        where: [placeholder, placeholder_in_string]
        trailing_text: none
        target: { scope: global, name: name }
```

`layers` is a DSL's composition of a common layer and per-environment overlays, or `none`. A DSL without layers still formats, navigates, and hovers.

A file matching two DSLs is reported and claimed by neither. Other YAML is untouched.

## Ownership

The extension contributes the language `yaml-dsl`. When the workspace config loads, each DSL's files are associated with that language: those its `includes` globs match and its `excludes` globs do not. Such a file opens as `yaml-dsl`, and the language server's document selector is that language.

An extension that selects `yaml` does not own these files and does not activate on them. The Red Hat YAML extension is one of those. A file that matches no DSL pattern stays `yaml`.

## Out of scope

- Running the engine that accepts the file.
- A DSL's schema or definition shipped inside the extension.

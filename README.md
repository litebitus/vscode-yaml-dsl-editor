# YAML DSL Editor

The editor that makes a YAML DSL authorable.

A DSL is a block in `yaml-dsl.yml` at the root of a workspace. Nothing about a particular DSL is compiled into the extension, and the block states every rule; there are no defaults. The block says which files belong, the DSL's scopes, where names are declared and how they are referenced, its placeholders and functions, when the DSL has layers which directories are overlays, and a schema search path for a file that does not name one. Scopes, references, placeholders and calls are the same ideas in every DSL. Each block supplies the syntax.

The spec is [docs/design.md](docs/design.md).

```yaml
# yaml-dsl.yml
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
    placeholder:
      pattern: "\\$\\{(?<body>[^}\\n]*)\\}"
      unscanned_paths: []
    function:
      definitions: [terraform]
      call_result_reference_positions: [whole_scalar]
      calls_not_allowed_at:
        - { path: "$.*", skip_keys: [], includes_subtree: false }
      marker_function:
        call_marker: fn.
        splat_operator: "*"
        calls_without_name_allowed: true
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
        skip_keys: [locals, outputs]
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
```

Open a file the config matches. When the DSL has layers, that file is one layer of a stack. The language server holds the common layer and every adjacent overlay.

- [The DSL](#the-dsl)
- [Hover](#hover)
- [Navigation](#navigation)
- [Completion](#completion)
- [Layers](#layers)
- [Schema](#schema)
- [Ownership](#ownership)
- [Colors](#colors)
- [Publish](#publish)
- [Development](#development)
  - [Tests](#tests)

## The DSL

`yaml-dsl.yml` is one file at the workspace root. `version` is the config format, `"1"`. Each entry under `dsls` is one language. A block left out is a feature the DSL does not have.

| Field | What it sets |
|---|---|
| `id` | Name of the DSL |
| `file_includes` | Globs of files that belong to it |
| `file_excludes` | Globs of files that do not, even when `file_includes` matches them |
| `schema_search_paths` | Search path used when a file does not name a schema, or the path it names is not on disk. Each entry is relative to that file. The first one on disk wins. A URL is fetched. |
| `layers` | `overlay_folders`, the folder names of the overlays, and `common_layer_discovery`, how the common layer is found (`parent` or `ancestor`) |
| `placeholder` | The placeholder's `pattern` with a `body` group, and `unscanned_paths`, the paths whose text is another language's |
| `function` | Where the function definitions come from (`definitions`), the positions a call result may be referenced from (`call_result_reference_positions`), the paths where a call is a problem (`calls_not_allowed_at`), and the call grammar of a marker function (`marker_function`) |
| `scopes` | Each scope's `regions`, a list of paths (`$` is the whole fold); `later_items_of_declaring_list`; `named_by_parent_key`; and `builtin_names`. A logical scope is named in capitals. |
| `declarations` | Where a name is declared (`path`, `skip_keys`, `exclude_candidates`), how it is read (`name_source` `key`, `value` or `meta_argument`, with `key_token`, `name_spelling` and `meta_argument_name`), `declares_every_name`, and its `scope_name` |
| `references` | A `pattern` with named groups, the `positions` it may stand in, `text_after_name_allowed`, the `scope_name`, and the groups holding a parent-key scope (`scope_group`) and the name (`name_group`) |

`positions` lists `whole_scalar`, the scalar; `whole_placeholder`, a placeholder that is the whole scalar; `placeholder_in_text`, a placeholder inside longer text; and `anywhere_in_scalar`, each match inside a scalar.

`function.definitions` lists `terraform`, read from `terraform metadata functions -json` when Terraform can be invoked, and `schema`, the table the file's schema publishes at `#/x-yaml-dsl-functions` in the format of [schemas/x-yaml-dsl-functions.schema.json](schemas/x-yaml-dsl-functions.schema.json).

Calls are modeled in one shape only, the marker function: a call written in a key, `<name> <call_marker><function>`, with the splat operator after the function when the value below is a list of arguments. A call written in a value, such as `hosts: concat(["a", "b"])`, is a plain string to the extension. A DSL whose calls take another shape gets no call checks, hover, completion or coloring.

Every reference, placeholder and call is checked. A reference that resolves to nothing visible, a placeholder no rule reads, a call to an unknown function, a wrong argument count or a literal argument of the wrong type is red. References, placeholders and calls are colored from these rules.

A DSL without `layers` still hovers and navigates. Its stack is the one file.

## Hover

Hover reads the schema as authored. A field whose value `$ref`s a shared composite keeps the description written beside that `$ref`. The composite's text is the shape of the value. It is not the tooltip.

Hover on a reference shows a scalar declaration's value as authored, or the target's scope, name and file. Hover on a builtin names its scope. Hover on a function shows its signature.

When no schema resolves, the modeline line gets a red squiggle, or the first line when there is no modeline, and field hovers stay empty. Navigation still runs.

## Navigation

A reference is underlined as soon as the file opens. Once the analysis answers, one that stays in this file keeps a straight underline, one that points at another file becomes a squiggle, and one that matches nothing visible turns red with a red squiggle. Otherwise the text keeps its own colors. Resting on one shows its declaration after a second, in this language. Command-click opens the declaration. Moving the pointer away before the delay cancels it. The references peek is not opened. When nothing visible matches, the cursor does not move.

A reference resolves in its target scope, among the names whose scope's regions hold where it stands: the paths the scope names, `$` being the whole fold, or the later items of the declaring list. In `sample.yml` a ref is a whole scalar `ref <type>.<name>`, with an optional field path after the name. The resource's identity is the last token of its key, with `-` written as `_`. A key holding a local placeholder is also named by the local's value, spelled the same way. A local is a key under `locals`, referenced as a whole scalar `local.<name>` or `${local.<name>}` inside a scalar or a key.

An overlay's fold is its own declarations over the common layer's: its own declaration wins, and it sees no other overlay's. The common layer sees its own declarations and a name declared in every overlay that has a file, which opens in the first such overlay `layers.overlay_folders` lists.

## Completion

Typing the start of a reference, a placeholder or a call opens the list of what it can name, and every character narrows it by fuzzy match: `ref mtprim` finds `ref mocktype.primary`. Each entry names the declaring file and shows the declaration. Enter inserts it. The list holds what the file's fold sees and what is visible from the cursor: an overlay offers the common layer and its own declarations, and the common layer offers its own and those declared in every overlay. The forms come from the config's reference rules and placeholders, builtins are offered inside a placeholder, and the vocabulary after a call marker.

## Layers

A DSL with `layers` composes a stack. One file is the common layer. Each overlay is the same filename under a directory named in `layers.overlay_folders` directly below the common layer's directory. With `layers.common_layer_discovery: parent` the overlay directory holds the file itself. With `ancestor` the file may sit deeper, at the same path below the overlay directory in every overlay, so `mock-stack/one/config/sample.yml` takes `mock-stack/sample.yml`. A file below no overlay directory is a common layer. The same shape without an extra directory (`mock-family/sample.yml` beside `mock-family/one/`) is the same composition.

```
mock-stack/sample.yml
mock-stack/one/sample.yml
mock-stack/two/sample.yml
```

Activating any file in the stack puts the common layer and every adjacent overlay in scope. Switching files inside that stack uses the copy the server already holds.

Each overlay's folded document is the common layer merged under that overlay. It is not opened on its own. Typing stays in the layer files. An overlay with no file is empty on the common layer.

The server loads a stack when a file in it becomes active. It does not load the rest at startup. The stack of the active editor is pinned, and so is any stack whose folded buffer is on screen. Capacity beyond the pins is 8 stacks. Loading one past that drops the least recently used unpinned stack and closes its folded buffers. The files on disk stay. A change to a resident stack updates it in place.

## Schema

The schema for a file is the one the file names. A `# yaml-language-server: $schema=` modeline is honored. The path is relative to that file.

An overlay may name `.schema/sample.schema.json`. A common layer may name that file through an overlay directory, such as `one/.schema/sample.schema.json`.

A modeline that resolves is never overridden. The config `schema_search_paths` list is the search path for a file with no modeline, or a modeline whose path is not on disk. The same schema bytes are one parsed copy. Different bytes are a different schema. Evicting a stack drops its layers and folded documents, not the schema.

The extension ships no DSL's schema or definition.

## Ownership

The extension contributes the language `yaml-dsl`. It starts only when a workspace folder contains `yaml-dsl.yml`. A folder without that file is left alone, including in a window that also has a folder with the file.

A file under a folder that has the config, and that one DSL's `file_includes` match and its `file_excludes` do not, opens as `yaml-dsl`. The language server's document selector is that language. A file that matches no DSL pattern stays `yaml`. A file that matches two DSLs is reported and claimed by neither.

## Colors

A matching file uses this extension's file icon. The editor's bracket pair colorization does not apply, so a bracket keeps the color of the text it stands in. Colors follow the HCL editor: keys are identifiers, strings are strings, and numbers and `true` / `false` / `null` are constants. References and placeholders are colored from the config: a reference rule's leading literal is a function, its target groups are types and names, a placeholder's delimiters and builtin body have their own colors, and a call's marker and function are colored as HCL colors a function call. A `#` starts a comment only at the start of a line or after whitespace.

## Publish

Open VSX listing: https://open-vsx.org/extension/lite2073/yaml-dsl-editor

Marketplace listing: https://marketplace.visualstudio.com/items?itemName=lite2073.yaml-dsl-editor

One-time setup:

1. Publisher `lite2073` created at https://marketplace.visualstudio.com/manage
2. Azure DevOps PAT (https://aex.dev.azure.com → user settings → Personal access tokens):
   scope **Marketplace → Manage**, organization **All accessible organizations**
3. Open VSX token from https://open-vsx.org (profile → Access Tokens),
   exported as `OVSX_PAT` — Open VSX serves VSCode forks like Antigravity
4. `npm i -g @vscode/vsce ovsx`
5. `vsce login lite2073` (paste the PAT)

Each release:

```sh
make publish              # bump patch; publish to Open VSX + VS Code Marketplace; push tag
make publish BUMP=minor   # bump minor instead
```

To only build the .vsix without publishing: `make package`.
To retry a single store for the current version: `make publish-ovsx` / `make publish-vsce`.

## Development

First remove any installed copy — with equal versions it's undefined which
copy the editor loads:

1. Quit the editors (a running editor can rewrite the extension registry
   from memory).
2. Run `make uninstall` — wipes the extension from VSCode and Antigravity.
3. Relaunch the editors.

Then, for every code change, run the full three-step cycle:

1. `make package` — runs the tests, then builds a fresh `yaml-dsl-editor.vsix`
2. `make install-cursor` — installs that `.vsix` into Cursor
   (no uninstall needed — installing replaces the existing copy, even at the
   same version)
3. **Developer: Reload Window**

Skipping any step means testing stale code: the editor keeps running the old
build until reload, and an old `.vsix` silently reinstalls the previous code.
When in doubt whether a fix is actually installed, check the extension folder
(`~/.antigravity-ide/extensions/` or `~/.vscode/extensions/`) for the change.

For quick iteration without installing: open this folder in VSCode and press
F5 (Extension Development Host). There is no compile step. The extension is plain JavaScript.

### Tests

`make test` runs the unit suite and fails if line coverage or branch coverage of the extension's own code is under 90%. Test files are not part of the measured set. `make test-all` runs that suite, then downloads each exact version in `vscodeTestVersions` in `package.json` and runs `test/integration` in it. It does not use an editor installed on the machine. `make package` runs `test-all` before it builds the `.vsix`.

# YAML DSL Editor

The editor that makes a YAML DSL authorable.

A DSL is a block in `yaml-dsl.yml` at the root of a workspace. Nothing about a particular DSL is compiled into the extension. The block says which files belong, the syntax of a ref and of a local, when the DSL has layers which directories are environments, and a schema search path for a file that does not name one. A ref and a local are the same ideas in every DSL. Each block supplies the syntax.

A layered DSL is the first one the editor is proven against. Others come after that works. The spec is [docs/design.md](docs/design.md).

```yaml
# yaml-dsl.yml
dsls:
  - id: sample
    match: ["**/sample.yml"]
    schema:
      - .schema/sample.schema.json
      - side/.schema/sample.schema.json
    layers:
      environments: [one, two]
    symbols:
      - kind: local
        at: "$.locals.*"
        name: { from: key }
      - kind: item
        at: "$.*.*"
        skip: [meta]
        exclude: [skipme]
        name: { from: key, token: last, spelling: snake }
        qualify: { type: parent }
    references:
      - pattern: "^ref (?<type>[a-z0-9_]+)\.(?<name>[a-z0-9_]+)"
        where: whole
        target: { kind: item, type: type, name: name }
      - pattern: "^local\.(?<name>[a-z0-9_]+)$"
        where: whole
        target: { kind: local, name: name }
      - pattern: "\$\{local\.(?<name>[a-z0-9_]+)\}"
        where: within
        target: { kind: local, name: name }
```

Open a file the config matches. When the DSL has layers, that file is one layer of a stack. The language server holds the common layer and every adjacent overlay.

- [The DSL](#the-dsl)
- [Hover](#hover)
- [Navigation](#navigation)
- [Layers](#layers)
- [Schema](#schema)
- [Ownership](#ownership)
- [Colors](#colors)
- [Publish](#publish)
- [Development](#development)
  - [Tests](#tests)

## The DSL

`yaml-dsl.yml` is one file at the workspace root. Each entry under `dsls` is one language.

| Field | What it sets |
| --- | --- |
| `id` | Name of the DSL |
| `match` | Globs of files that belong to it |
| `schema` | Search path used when a file does not name a schema, or the path it names is not on disk. Each entry is relative to that file. The first one on disk wins. A URL is fetched. |
| `layers.environments` | Directory names of the overlays, beside the common file |
| `symbols` | Where a local or a resource is declared, and how its name is read |
| `references` | Which scalars are refs or locals, and which symbol they point at |

`at` is `$`, `.key`, `.*`, and `[*]`. `skip` lists keys a `.*` step does not descend into. `exclude` lists keys that are not symbols. `token: last` takes the key's last whitespace-separated token. `spelling: snake` writes `-` as `_`. `qualify.type: parent` is the mapping key that contains the symbol, and the reference's `type` group must equal it.

`where: whole` means the scalar is the reference. `where: within` means each match inside the scalar is a reference.

A DSL without `layers` still hovers and navigates. Its scope is the one file.

## Hover

Hover reads the schema as authored. A field whose value `$ref`s a shared composite keeps the description written beside that `$ref`. The composite's text is the shape of the value. It is not the tooltip.

Hover on a ref shows the target's type, identity, and file. Hover on a local shows the value as authored.

When no schema resolves, the file gets one diagnostic and field hovers stay empty. Ref and local navigation still run.

## Navigation

A ref or a local that stays in this file is blue. One that points at another file is peach. Both are underlined. Resting on either shows that declaration after a second, in this language. Command-click opens the declaration. Moving the pointer away before the delay cancels it. The references peek is not opened. When nothing in scope matches, the cursor does not move.

In the resource DSL a ref is a whole scalar `ref <type>.<name>`, with an optional field path after the name. The field path is not a separate target. The resource's identity is the last token of its key, with `-` written as `_`. A `${...}` placeholder is compared as written. A name that is the same spelling of a local's value, with `-` written as `_`, points at the resource whose key contains that local.

A local is a key under `locals`. A reference is a whole scalar `local.<name>`, or `${local.<name>}` inside a scalar or a key.

Scope is the active stack: the common layer and every adjacent overlay. A ref in one file may name a declaration in another file of that stack. When the same symbol is in more than one file, the common layer wins, then the active file, then the other overlays in path order.

## Layers

A DSL with `layers` composes a stack. One file is the common layer. Each environment is an overlay: the same filename in a directory named in `layers.environments`, beside that file. The same shape without an extra directory (`mock-family/sample.yml` beside `mock-family/one/`) is the same composition.

```
mock-stack/sample.yml
mock-stack/one/sample.yml
mock-stack/two/sample.yml
```

Activating any file in the stack puts the common layer and every adjacent overlay in scope. Switching files inside that stack uses the copy the server already holds.

Each environment's folded document is the common layer merged under that overlay. It is not opened on its own. Typing stays in the layer files. An environment with no file is an empty overlay on the common layer.

The server loads a stack when a file in it becomes active. It does not load the rest at startup. The stack of the active editor is pinned, and so is any stack whose folded buffer is on screen. Capacity beyond the pins is 8 stacks. Loading one past that drops the least recently used unpinned stack and closes its folded buffers. The files on disk stay. A change to a resident stack updates it in place.

## Schema

The schema for a file is the one the file names. A `# yaml-language-server: $schema=` modeline is honored. The path is relative to that file.

An overlay may name `.schema/sample.schema.json`. A common layer may name that file through an environment directory, such as `one/.schema/sample.schema.json`.

A modeline that resolves is never overridden. The config `schema` list is the search path for a file with no modeline, or a modeline whose path is not on disk. The same schema bytes are one parsed copy. Different bytes are a different schema. Evicting a stack drops its layers and folded documents, not the schema.

The extension ships no schema and no DSL definition.

## Ownership

The extension contributes the language `yaml-dsl`. It starts only when a workspace folder contains `yaml-dsl.yml`. A folder without that file is left alone, including in a window that also has a folder with the file.

A file under a folder that has the config, and that matches one DSL `match` pattern, opens as `yaml-dsl`. The language server's document selector is that language. A file that matches no DSL pattern stays `yaml`. A file that matches two DSLs is reported and claimed by neither.

## Colors

A matching file uses this extension's file icon. Colors follow the HCL editor: keys are identifiers, `ref` is a function, the names in a ref are types, strings are strings, `${` and `}` are interpolation marks, and the name inside them is an identifier. Numbers and `true` / `false` / `null` are constants.

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

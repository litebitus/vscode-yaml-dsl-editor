# YAML DSL Editor

The editor that makes a YAML DSL authorable.

## Features

### The DSLs it handles

A YAML DSL is YAML with a language on top. The extension handles DSLs built from these features:

- References: one part of the document names another, so a value states what it depends on rather than copying it.
- Scopes: names are grouped by kind and visible only where the DSL says, so the same name can mean different things in different parts of the document.
- Locals: named values declared once and used anywhere, built from each other.
- Placeholders: values left open in the document and filled in when the engine reads it, such as the environment or the region.
- Functions: values computed from other values, such as a merge of maps or a joined list.
- Layers: one document split into a shared common layer and per-environment overlays, so what every environment shares is written once and each overlay states only how it differs.
- Schema: the fields and their documentation, described once for every file.

### Any DSL, declared in config

Each DSL is a block in `yaml-dsl.yml`, and nothing about a DSL is built in.

### Layered stacks

A file's concern is the nearest directory above it that is not an overlay directory. A concern's overlays and the common layer they take are one stack. Each overlay's folded document, the common layer merged under it, opens beside the file you edit.

#### Concern above its overlays

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

#### Concern below its overlays

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

### Schema hover

Hover reads the schema as authored, so a field shows the description written beside its `$ref`, not the shared composite's. A deprecated field is a warning: struck through, marked in the gutter, and its file and folders shown in yellow.

The JSON Schema drafts read, each by its own parser:

- draft 2020-12
- draft 2019-09
- draft-07 (assumed when `$schema` is missing or names an older draft)

### Navigation and completion

References, locals, placeholders and calls go to their declaration and complete from what the file's fold sees. A common layer reference reaching a declaration in several overlays opens them all, one section per overlay, on Command-click.

### Renaming

Rename Symbol renames a name across the whole stack, every layer's declaration and every reference, from its shortcut or the context menu. A name edited by hand offers to rename the rest of the stack in one click.

### Problems

A reference nothing declares, an unknown placeholder and a call the DSL's function table rejects are marked as you type.

### Suggestions

A block the overlays repeat moves into the common layer in one click, its differences written as locals. A repeat of the common layer is deleted from an overlay the same way. Every move is checked against each overlay's schema first. One undo reverts the whole move, across every file, and saves them.

### Overlay diff

Select lines, or put the cursor on one, then open the diff with any of:

- the diff button <img src="media/diff-button.png" alt="diff button" height="16"> in the editor's title bar
- `Diff across overlays` in the right-click menu
- `YAML DSL: Diff across overlays` in the Command Palette

One view beside the file shows how every overlay configures them, each differing value labeled with the overlays that hold it, each difference in its own color. The view follows the selection.

Narrow the view to the overlays you check with either:

- the filter button <img src="media/filter-button.png" alt="filter button" height="16"> in the view's title bar, which shows once you click in the view
- `YAML DSL: Choose overlays to diff` in the Command Palette

The colors are theme colors you can override with `workbench.colorCustomizations`.

### Responsive and bounded

The active file's work starts at once, ahead of background work, and every cache has a set capacity.

The design is [docs/design.md](docs/design.md).

## Configuration file

`yaml-dsl.yml` at the root of a workspace folder declares the workspace's DSLs, one entry under `dsls` each, in the format `version: "1"`. The extension checks it against its JSON Schema, [schemas/yaml-dsl.schema.json](schemas/yaml-dsl.schema.json), shows its problems in the file, and applies it when it is saved. Each field is described in that schema, and what the fields do together is in the design doc.

## Settings

The extension's own settings live under `yaml-dsl-editor` in the editor's settings. They set how the editor behaves for its user. What a DSL is lives in `yaml-dsl.yml`.

| Setting | Values | What it sets |
|---|---|---|
| `yaml-dsl-editor.cache.schemaCapacity` | a whole number, 1 or more | Distinct schemas kept beyond those a loaded stack uses |
| `yaml-dsl-editor.cache.stackCapacity` | a whole number, 1 or more | Stacks kept beyond the pinned ones |
| `yaml-dsl-editor.suggestion.delete.enabled` | `true`, `false` | Whether delete suggestions are shown |
| `yaml-dsl-editor.suggestion.delete.fileDecoration` | `true`, `false` | Whether a file holding a delete suggestion, and its folders, are colored |
| `yaml-dsl-editor.suggestion.move.enabled` | `true`, `false` | Whether move suggestions are shown |
| `yaml-dsl-editor.suggestion.move.fileDecoration` | `true`, `false` | Whether a file holding a move suggestion, and its folders, are colored |
| `yaml-dsl-editor.suggestion.potentialMove.enabled` | `true`, `false` | Whether potential move suggestions are shown |
| `yaml-dsl-editor.suggestion.rename.enabled` | `true`, `false` | Whether rename suggestions are shown |
| `yaml-dsl-editor.suggestion.rename.fileDecoration` | `true`, `false` | Whether a file holding a rename suggestion, and its folders, are colored |
| `yaml-dsl-editor.warning.deprecation.enabled` | `true`, `false` | Whether deprecation warnings are shown |
| `yaml-dsl-editor.warning.deprecation.fileDecoration` | `true`, `false` | Whether a file holding a deprecation warning, and its folders, are colored |

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

`make test` runs the unit suite and its coverage gate. `make test-all` runs that suite, then downloads each exact version in `vscodeTestVersions` in `package.json` and runs `test/integration` in it. It does not use an editor installed on the machine. `make test-antigravity` and `make test-cursor` run `test/integration` in the Antigravity IDE and Cursor installed under `/Applications`, and are skipped when that editor is not installed. `make package` runs `test-all` before it builds the `.vsix`.

### Publish

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

Before the bump, `make publish` runs `make test-antigravity` and `make test-cursor`, so a release is tested in each target editor installed on the machine. The version bump renames the CHANGELOG's `## Unreleased` heading to the new version and the date, in the release commit; a release without that heading stops before the bump.

To only build the .vsix without publishing: `make package`.
To retry a single store for the current version: `make publish-ovsx` / `make publish-vsce`.

## Footnotes

The diff and filter button images are the `diff` and `filter` icons from [Codicons](https://github.com/microsoft/vscode-codicons), © Microsoft, CC BY 4.0.

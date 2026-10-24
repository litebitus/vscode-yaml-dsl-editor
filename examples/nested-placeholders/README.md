# Nested placeholders example

A mock DSL whose placeholder `pattern` lets a placeholder hold another in its body. `resources.yaml` is the document; `yaml-dsl.yml` is the config and `mock-nested.schema.json` the schema.

| Where | What the editor shows |
|---|---|
| `${region}` in `objects.pattern` | a placeholder of its own inside the outer one: hover documents `region` as a builtin |
| `local.buckets` in `objects.pattern` | the outer placeholder, read by the `local` rule with the key path after the name; hover shows `buckets`, and Command-click opens it in `locals` |
| `${9}` in `unread.pattern` | `unknown placeholder ${9}`: no rule reads the inner body, while the outer one is still read |

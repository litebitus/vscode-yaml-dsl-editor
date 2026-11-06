# Computed values example

A mock DSL whose values may be computed: by a call without a name, a reference or a placeholder. Such a value is known only when the document is used, so it is not checked against its field's type. `resources.yaml` is the document; `yaml-dsl.yml` is the config and `mock-computed.schema.json` the schema, with the function table.

| Where | What the editor shows |
|---|---|
| the second item of `service.api.command` | a call without a name stands as a string item, its arguments checked against `format` and `join`, its value not |
| `service.api.replicas` | `local.replicas` stands in an integer field; Command-click opens it in `locals` |
| `service.api.max_replicas` | the placeholder `${max_replicas}` stands in an integer field; hover documents it as a builtin |
| `service.api.ports` | `local.ports` stands in a list of integers |
| `service.api.peer` | `ref service.worker` stands in an object field; Command-click opens `worker` |
| `service.worker.replicas` | `` `replicas` must be integer ``: `two` is written as is |

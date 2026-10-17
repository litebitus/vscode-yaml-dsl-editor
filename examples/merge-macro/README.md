# Merge macro example

A mock DSL whose `merge` macro merges maps from its argument under the map holding the call. `resources.yaml` is the common layer and `dev/resources.yaml` its overlay; `yaml-dsl.yml` is the config and `mock-merge.schema.json` the schema, with the function table.

| Where | What the editor shows |
|---|---|
| `orders` in `resources.yaml` | `fn.merge: local.queue_defaults` supplies `retention_seconds` and `visibility_seconds`, so the queue is valid; hover on `fn.merge` documents the macro |
| `orders_failed` in `resources.yaml` | its own `retention_seconds` goes over the local's |
| `payments` in `dev/resources.yaml` | `local.queue_defaults` comes from the common layer; `local.slow_queue` goes over it, and its `visibility_seconds: slow` is an error at `fn.merge*`: `` `visibility_seconds` must be integer `` |
| `refunds` in `dev/resources.yaml` | `ref queue.orders` is known only when the document is used, so the queue's required fields are not reported; the local's wrong type still is |
| `audits` in `dev/resources.yaml` | no merge: `retention_seconds` and `visibility_seconds` are required |

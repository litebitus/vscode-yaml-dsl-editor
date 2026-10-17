# Merge macro example

A mock DSL whose `merge` macro merges maps from its argument under the map holding the call. `resources.yaml` is the common layer and `env1/resources.yaml` its overlay; `yaml-dsl.yml` is the config and `mock-merge.schema.json` the schema, with the function table.

| Where | What the editor shows |
|---|---|
| `orders` in `resources.yaml` | `fn.merge: local.queue_defaults` supplies `retention_seconds` and `visibility_seconds`, so the queue is valid; hover on `fn.merge` documents the macro |
| `orders_failed` in `resources.yaml` | `fn.merge: local.dead_letter_queues` declares it under `queue`, so `ref queue.orders_failed` resolves, and Command-click opens it in `locals`; its own `retention_seconds` goes over `local.queue_defaults` |
| `payments` in `env1/resources.yaml` | `local.queue_defaults` comes from the common layer; `local.slow_queue` goes over it, and its `visibility_seconds: slow` is an error at `fn.merge*`: `` `visibility_seconds` must be integer `` |
| `refunds` in `env1/resources.yaml` | `ref queue.orders` is known only when the document is used, so the queue's required fields are not reported; the local's wrong type still is |
| `audits` in `env1/resources.yaml` | no merge: `retention_seconds` and `visibility_seconds` are required |
| `notifications` in `env1/resources.yaml` | `local.dead_letter_queues.orders_failed` merges the map at that path, through its own merge of `local.queue_defaults`; Command-click opens `orders_failed` |
| `retention_seconds` in `locals.queue_defaults` | hover documents it as the queue field it lands on, and completion offers the queue's fields |

# Loop macro example

A mock DSL whose `loop` macro repeats a body once per item of a list or a map, its loop variables read with a `~` sigil: `~name` as a whole value, `${~name}` inside a string. `resources.yaml` is the document; `yaml-dsl.yml` is the config, its `loops.scope_name` naming the scope whose rule reads `~`, and `mock-loop.schema.json` the schema, with the function table.

| Where | What the editor shows |
|---|---|
| `fn.loop` under `queue` | hover documents the macro, `for?: list = ["it"]` among its arguments; the loop has no name, so its map body's entries land among `queue`'s, declaring `orders` and `payments` |
| `for`, `in` or `body` | hover documents the argument; a new key in the loop's map offers the arguments not yet written |
| `dead_letters fn.loop` | a list over a list: `dead_letters` holds `orders-failed` and `payments-failed`; the loop states no loop variables, so `~it` binds each item |
| `replicas fn.loop` | a map over a map: `for` declares two loop variables, `replica` for the key and `region` for the value |
| `regions fn.loop` | a list over a map: `~it` binds each value, in key order |
| `endpoints fn.loop` | a loop in a loop's body: `${~region}` reads the outer loop's name |
| `${~name}` or `~region` | hover shows the loop that declares the loop variable and the items it is bound to; a value typed in a loop's body completes its loop variables |
| `ref queue.orders` in `reports` | resolves to the key the loop's body writes, and Command-click opens it |
| `fn.loop` under `reports` | its entries land among the queue's fields, so each is an error naming the item it holds for: `` `orders_retention` is not a field of `reports` (for `orders`) `` |

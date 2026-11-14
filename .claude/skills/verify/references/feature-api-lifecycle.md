# api-lifecycle

Run this journey on the `local` target. Before it, run `bun verify use --target local`,
`bun verify up` and `bun verify doctor`.

The journey checks that an operator can create an imp, list it, put it to sleep and destroy it
through impd's API. `bun verify up` also starts `impz events`, the CLI's event feed, and records
what it prints. `bun verify imp-events` reads that record, from the point that `use --feature`
marks.

The journey's imp is `wv-api`. When a step gives a result that the end state doesn't expect, skip to
`destroy-imp`, so the next run starts with no `wv-api`. `destroy-imp` exits 0 when the imp is
already gone, so you may also run it before `use --feature` to clear a leftover.

## Journey

```bash
bun verify use --feature api-lifecycle
bun verify action create-imp --name wv-api
bun verify imps list
bun verify action sleep-imp --name wv-api
bun verify action destroy-imp --name wv-api
bun verify imp-events --name wv-api
bun verify imps list
```

## End state

`imps list` acts with impd's root token, so `data.imps` lists every imp, each with its `name` and
`state`.

- `create-imp` returns `data.state: "running"`.
- The first `imps list` holds `wv-api` with state `running`.
- `sleep-imp` returns `data.state: "sleeping"`.
- `destroy-imp` returns `data.existed: true`.
- `imp-events` exits 0. It found these events in this order, with others allowed between them:
  - `ImpAdded` with reason `created`;
  - `ImpChanged` to state `running`;
  - `ImpChanged` to state `sleeping`, with reason `slept`;
  - `ImpRemoved`.
- The last `imps list` holds no `wv-api`.

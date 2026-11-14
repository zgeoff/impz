# api-lifecycle

Run this journey on the `local` target: run `bun verify use --target local` and `bun verify up`
first. It checks that an operator can create an imp (impd's microVM) through impd's API, list it,
put it to sleep and destroy it, and that `bun verify imp-events` sees each step in the events that
`impz events` printed during the journey.

When a step fails, still run `destroy-imp`, so the next run starts with no `wv-api`. It exits 0 when
the imp is already gone, so you can also run it first to clear a leftover from an earlier run.

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

- `create-imp` returns `data.state: "running"`.
- The first `imps list`, which sees every imp, holds `wv-api` with state `running`.
- `sleep-imp` returns `data.state: "sleeping"`.
- `destroy-imp` returns `data.existed: true`.
- `imp-events` exits 0. It checks that these events came in this order, with others allowed between
  them: `ImpAdded` with reason `created`, `ImpChanged` to `running`, `ImpChanged` to `sleeping` with
  reason `slept`, then `ImpRemoved`.
- The last `imps list` holds no `wv-api`.

# api-lifecycle

An operator creates an imp through impd's API, lists it, puts it to sleep and destroys it.
`impz events`, which the run records as the `events` stream, shows each step. Run it on `local`.

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

- `create-imp` returns `data.state` `running`, and the first `imps list` holds `wv-api` as
  `running`.
- `sleep-imp` returns `data.state` `sleeping`.
- `destroy-imp` returns `data.existed: true`.
- `imp-events` exits 0, with `data.events` in this order: `ImpAdded` with reason `created`, an
  `ImpChanged` to `running`, an `ImpChanged` to `sleeping` with reason `slept`, then `ImpRemoved`.
- The last `imps list` holds no `wv-api`.

# mcp-scope

Run this journey on the `local` target. Before it, run `bun verify use --target local`,
`bun verify up` and `bun verify doctor`.

The journey checks that an MCP client can act only on the imps that impd's service-clients file
gives it. The run's client may touch only imps named `wv-mcp-*`. The journey makes `wv-mcp-scope`
inside that scope and `wv-outside` outside it. Expect impd to refuse `imp_sleep` on `wv-outside`;
the command still exits 0.

When a step gives a result that the end state doesn't expect, skip to the two destroy steps, so the
next run starts with neither imp. When the MCP `imp_destroy` fails, run
`bun verify action destroy-imp --name wv-mcp-scope`, which exits 0 when the imp is already gone.

## Journey

```bash
bun verify use --feature mcp-scope
bun verify action create-imp --name wv-outside
bun verify mcp call imp_create --args '{"name":"wv-mcp-scope","image":"tiny"}'
bun verify mcp call imp_list
bun verify mcp call imp_sleep --args '{"name":"wv-outside"}'
bun verify mcp call imp_destroy --args '{"name":"wv-mcp-scope"}'
bun verify action destroy-imp --name wv-outside
bun verify imps list
```

## End state

Each `mcp call` prints an envelope whose `data.isError` says whether the tool failed, and whose
`data.content[0].text` holds the tool's result. `imps list` acts with impd's root token, so
`data.imps` lists every imp.

- `imp_create` returns `data.isError: false`, and its result names the imp `wv-mcp-scope`.
- The result of `imp_list` lists `wv-mcp-scope` and leaves out `wv-outside`.
- `imp_sleep` returns `data.isError: true`, and its result starts `FORBIDDEN`. Count any other
  refusal as a failure.
- `imp_destroy` returns `data.isError: false`, and `destroy-imp` returns `data.existed: true`.
- `data.imps` of `imps list` holds neither imp.

# mcp-scope

A service client signs in to impd's public MCP route with client credentials. Its entry in the
service-clients file lets it touch only imps named `wv-mcp-*`. The journey creates one imp inside
that scope and one outside it, and checks that the client may act on the first and is refused the
second. Run it on `local`.

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

- `imp_create` returns `data.isError: false`, with an imp named `wv-mcp-scope` in its text.
- `imp_list` lists `wv-mcp-scope` and no `wv-outside`.
- `imp_sleep` on `wv-outside` returns `data.isError: true`, with `FORBIDDEN` in its text.
- `imp_destroy` returns `data.isError: false`, and `destroy-imp` returns `data.existed: true`.
- The last `imps list` holds neither imp.

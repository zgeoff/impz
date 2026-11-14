# mcp-scope

Run this journey on the `local` target: run `bun verify use --target local` and `bun verify up`
first. It checks that an MCP client signed in to impd's public MCP route can act only on the imps
its scope names. `bun verify up` gives each run a service client whose scope is the imps named
`wv-mcp-*`. `bun verify mcp call` acts as that client, and `bun verify action` acts with impd's root
token, which sees every imp.

The journey makes `wv-mcp-scope` inside the scope and `wv-outside` outside it. When a step fails,
still run both destroy steps, so the next run starts with neither imp. `destroy-imp` exits 0 when
the imp is already gone.

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

Each `mcp call` returns the tool's answer in `data.isError` and in the text of
`data.content[0].text`.

- `imp_create` returns `data.isError: false`, and its text names the imp `wv-mcp-scope`.
- The text of `imp_list` lists `wv-mcp-scope` and leaves out `wv-outside`: the client sees only its
  scope.
- `imp_sleep` on `wv-outside` returns `data.isError: true`, and its text starts `FORBIDDEN`. Any
  other refusal is a failure.
- `imp_destroy` returns `data.isError: false`, and `destroy-imp` returns `data.existed: true`.
- `imps list` holds neither imp.

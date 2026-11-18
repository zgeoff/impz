# checkpoint-restore-fork

Run this journey on the `local-kvm` target. Before it, run `bun verify use --target local-kvm`,
`bun verify up` and `bun verify doctor`. Only `local-kvm` boots the guest VM that `imp_write_file`
and `imp_read_file` need. The journey checks that an MCP client can checkpoint an imp, restore the
imp to the checkpoint, and fork the checkpoint into a second imp.

`bun verify mcp call` signs in as an MCP client that impd lets touch only imps named `wv-mcp-*`; it
refuses any other name with `FORBIDDEN`. When a step fails, skip to the two `imp_destroy` calls, so
the next run starts with neither imp. Ignore `isError: true` from a destroy of an imp that never got
made.

## Journey

```bash
bun verify use --feature checkpoint-restore-fork
bun verify mcp call imp_create --args '{"name":"wv-mcp-cp","image":"tiny"}'
bun verify mcp call imp_write_file --args '{"name":"wv-mcp-cp","path":"/root/note","content":"before"}'
bun verify mcp call imp_checkpoint --args '{"name":"wv-mcp-cp","label":"first"}'
bun verify mcp call imp_write_file --args '{"name":"wv-mcp-cp","path":"/root/note","content":"after"}'
bun verify mcp call imp_restore --args '{"name":"wv-mcp-cp","checkpoint":"first"}'
bun verify mcp call imp_read_file --args '{"name":"wv-mcp-cp","path":"/root/note"}'
bun verify mcp call imp_fork --args '{"source":"wv-mcp-cp","name":"wv-mcp-fork","checkpoint":"first"}'
bun verify mcp call imp_read_file --args '{"name":"wv-mcp-fork","path":"/root/note"}'
bun verify mcp call imp_destroy --args '{"name":"wv-mcp-fork"}'
bun verify mcp call imp_destroy --args '{"name":"wv-mcp-cp"}'
bun verify imps list
```

## End state

Each `mcp call` prints an envelope whose `data.isError` says whether the tool failed, and whose
`data.content[0].text` holds the tool's JSON result.

- Each `mcp call` returns `data.isError: false`.
- The result of `imp_checkpoint` holds `"label": "first"`.
- The result of the `imp_read_file` on `wv-mcp-cp` holds `"content": "before"`: the restore undid
  the second write.
- The result of `imp_fork` names the imp `wv-mcp-fork`.
- The result of the `imp_read_file` on `wv-mcp-fork` holds `"content": "before"`.
- `imps list` holds neither imp.

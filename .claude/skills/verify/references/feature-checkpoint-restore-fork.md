# checkpoint-restore-fork

Run this journey on the `local-kvm` target: run `bun verify use --target local-kvm` and
`bun verify up` first. `imp_write_file` and `imp_read_file` run commands in a guest VM, which only
`local-kvm` boots. The journey checks that an MCP client can checkpoint an imp, restore the imp to
the checkpoint, and fork the checkpoint into a second imp.

`bun verify mcp call` acts as the run's service client, which may touch only imps named `wv-mcp-*`,
so keep that prefix on any imp you add. When a step fails, still run both `imp_destroy` calls, so
the next run starts with neither imp.

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

Each `mcp call` returns the tool's answer in `data.isError` and in the text of
`data.content[0].text`.

- Each `mcp call` returns `data.isError: false`.
- The text of `imp_checkpoint` holds a checkpoint with label `first`.
- The text of the `imp_read_file` on `wv-mcp-cp` holds content `before`: the restore undid the
  second write.
- The text of `imp_fork` names the imp `wv-mcp-fork`, and its `imp_read_file` holds content
  `before`.
- `imps list` holds neither imp.

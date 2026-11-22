# checkpoint-restore-fork

Check that an MCP client can checkpoint an imp, restore the imp to the checkpoint, and fork the
checkpoint into a second imp. Run this journey on the `local-kvm` target, and switch to it first as
[Real VMs](local-kvm.md#switch-targets) shows. Only `local-kvm` boots the guest VM that
`imp_write_file` and `imp_read_file` need.

`bun verify mcp call` signs in as an MCP client that impd lets touch only imps named `wv-mcp-*`.
impd refuses any other name with `FORBIDDEN`.

A step fails when its command exits non-zero, or when it exits 0 with `data.isError: true`, which
means the tool failed. When a step exits 0 with `isError: true`, ignore the Exit codes row for 0,
which says to go on: skip straight to the two `imp_destroy` calls and `imps list`, so the next run
starts with neither imp. For a non-zero exit, do what its row in [Exit codes](exit-codes.md) says
first. When that row has you run the command or the journey again, do so, and go on from there if it
passes. When the step still fails, skip to the same destroys and `imps list`. Ignore `isError: true`
from a destroy of an imp that never got made.

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

# checkpoint-restore-fork

An MCP client checkpoints an imp before a risky change, restores the checkpoint, and forks it into a
second imp. The journey drives each step as the run's service client, so every imp it makes is named
`wv-mcp-*`. The file tools run in a real guest VM, so run it on `local-kvm`.

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

- Every call returns `data.isError: false`.
- `imp_checkpoint` returns a checkpoint with label `first`.
- The first `imp_read_file`, after the restore, returns content `before`, not `after`.
- `imp_fork` returns an imp named `wv-mcp-fork`, and its `imp_read_file` returns content `before`.
- `imps list` holds neither imp.

# sleep-wake

Run this journey on the `local-kvm` target: run `bun verify use --target local-kvm` and
`bun verify up` first. `exec-imp` runs a command in a guest VM, which only `local-kvm` boots. The
journey checks that a sleeping imp wakes when you run a command in it, with its disk as it was.

When a step fails, still run `destroy-imp`, so the next run starts with no `wv-sleep`. It exits 0
when the imp is already gone, so you can also run it first to clear a leftover from an earlier run.

## Journey

```bash
bun verify use --feature sleep-wake
bun verify action create-imp --name wv-sleep
bun verify action exec-imp --name wv-sleep --command 'echo kept > /root/note'
bun verify action sleep-imp --name wv-sleep
bun verify imps list
bun verify action exec-imp --name wv-sleep --command 'cat /root/note'
bun verify imps list
bun verify action destroy-imp --name wv-sleep
```

## End state

- The first `exec-imp` returns `data.exitCode: 0`.
- `sleep-imp` returns `data.state: "sleeping"`, and the first `imps list` holds `wv-sleep` with
  state `sleeping`.
- The second `exec-imp` returns `data.exitCode: 0` and `data.stdout: "kept\n"`.
- The second `imps list` holds `wv-sleep` with state `running`: the command woke it.
- `destroy-imp` returns `data.existed: true`.

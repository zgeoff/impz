# sleep-wake

Run this journey on the `local-kvm` target. Before it, run `bun verify use --target local-kvm`,
`bun verify up` and `bun verify doctor`. Only `local-kvm` boots the guest VM that `exec-imp` needs.
The journey checks that a sleeping imp wakes when you run a command in it, and keeps the file
written before the sleep.

The journey's imp is `wv-sleep`. When a step fails, skip to the last step, `destroy-imp`, so the
next run starts with no `wv-sleep`. `destroy-imp` exits 0 when the imp is already gone, so you may
also run it before `create-imp` to clear a leftover.

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

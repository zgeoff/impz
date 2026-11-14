# sleep-wake

An imp sleeps when idle and wakes when someone uses it, with its disk as it was. The journey writes
a file, puts the imp to sleep, and reads the file back with an exec, which wakes the imp. Run it on
`local-kvm`.

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
- `sleep-imp` returns `data.state` `sleeping`, and the first `imps list` shows `wv-sleep` as
  `sleeping`.
- The second `exec-imp` returns `data.exitCode: 0` and `data.stdout` `kept\n`.
- The second `imps list` shows `wv-sleep` as `running`: the exec woke it.
- `destroy-imp` returns `data.existed: true`.

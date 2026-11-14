# cli-create-exec

Run this journey on the `local-kvm` target: run `bun verify use --target local-kvm` and
`bun verify up` first. `impz exec` runs its command in a guest VM, which only `local-kvm` boots. The
journey checks, in a terminal, that a user can create an imp with `impz new`, run a command in it
with `impz exec`, and remove it with `impz rm`.

When a step fails, still run `bun verify action destroy-imp --name wv-cli`, so the next run starts
with no `wv-cli`. It exits 0 when the imp is already gone.

## Journey

Each `terminal wait` matches its regex against one screen row at a time.

```bash
bun verify use --feature cli-create-exec
bun verify terminal start shell
bun verify terminal type --text 'impz new wv-cli --image tiny'
bun verify terminal press enter
bun verify terminal wait --regex 'wv-cli +running' --timeout-ms 60000
bun verify terminal type --text 'impz exec wv-cli -- uname -a'
bun verify terminal press enter
bun verify terminal wait --regex '^Linux wv-cli '
bun verify terminal type --text 'impz rm wv-cli'
bun verify terminal press enter
bun verify terminal wait --regex '^\$\s*$'
bun verify terminal screen
bun verify terminal stop
bun verify imps list
```

## End state

- The first `terminal wait` passes: `impz new` printed a row for `wv-cli` in state `running`.
- The second `terminal wait` passes: the guest's hostname, in the `uname -a` line, is the imp's
  name.
- In `data.text` of `terminal screen`, no line between `$ impz rm wv-cli` and the last `$` prompt.
- `imps list` holds no `wv-cli`.

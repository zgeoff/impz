# cli-create-exec

Run this journey on the `local-kvm` target. Before it, run `bun verify use --target local-kvm`,
`bun verify up` and `bun verify doctor`. Only `local-kvm` boots the guest VM that `impz exec` needs.

The journey checks that a user can create an imp with `impz new`, run a command in it with
`impz exec`, and remove it with `impz rm`. It types each command into `shell`, the terminal program
the registry declares: a bash shell with the prompt `$ `, whose `impz` is this checkout's CLI,
signed in to the run's impd.

Run the commands one at a time. When a step gives a result that the end state doesn't expect, run
`bun verify terminal stop`, then `bun verify action destroy-imp --name wv-cli`, so the next run
starts with no `wv-cli`. `destroy-imp` exits 0 when the imp is already gone.

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
- The second `terminal wait` passes: the hostname in the `uname -a` line is the imp's name.
- `impz rm` printed nothing: in `data.text` of `terminal screen`, the `$` prompt comes on the line
  straight after `$ impz rm wv-cli`.
- `data.imps` of `imps list` holds no `wv-cli`.

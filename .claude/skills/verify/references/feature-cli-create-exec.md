# cli-create-exec

A user creates an imp with `impz new`, runs a command in it with `impz exec`, and removes it with
`impz rm`, in a terminal. The command runs in a real guest VM, so run it on `local-kvm`.

## Journey

```bash
bun verify use --feature cli-create-exec
bun verify terminal start shell
bun verify terminal type --text 'impz new wv-cli --image tiny'
bun verify terminal press enter
bun verify terminal wait --regex 'wv-cli +running' --timeout-ms 60000
bun verify terminal type --text 'impz exec wv-cli -- uname -a'
bun verify terminal press enter
bun verify terminal wait --regex 'Linux wv-cli '
bun verify terminal type --text 'impz rm wv-cli'
bun verify terminal press enter
bun verify terminal screen
bun verify terminal stop
bun verify imps list
```

## End state

- The screen shows a table row for `wv-cli` in state `running` after `impz new`.
- The line after `impz exec` starts `Linux wv-cli`: the guest's hostname is the imp's name.
- `impz rm` prints no error before the next prompt.
- `imps list` holds no `wv-cli`.

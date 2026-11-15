# Real VMs on local-kvm

Run each feature whose summary says "on a real VM" on `local-kvm`. On `local`, impd fakes its VMs
and never boots a guest, so those journeys fail there.

The mistakes to avoid:

- **Starting `local-kvm` while a `local` run is up.** A run lasts from `bun verify up` to
  `bun verify down`, and serves one target. End it first.
- **Removing another session's containers after a crash.** Every run's containers share one name
  prefix. Remove only your run's.

## Switch targets

```bash
bun verify down
bun verify use --target local-kvm
bun verify up
bun verify doctor
```

Expect: `ok: true` from each, and `data.passed: true` from `doctor`. To go back, run the same four
commands with `--target local`.

## What the machine needs

`bun verify up` on `local-kvm` starts impd in Docker with [`dev.sh`](../../../../scripts/dev/dev.sh)
in `scripts/dev/`. It needs:

- `/dev/kvm`, readable and writable by you;
- Docker;
- a guest kernel: `kernel/out/vmlinux` from [`build.sh`](../../../../kernel/build.sh) in `kernel/`,
  or the path to a built one in `IMP_KERNEL`, set in the shell that runs `up`;
- this checkout's host image, the Docker image impd runs in.

When one is missing, `doctor` fails its `host` check. Read the check's `message` in `data.results`:
it holds the missing part and the command to run, such as the one that builds the host image.

## After a crash

`bun verify down` removes the run's Docker containers. When the run's supervisor, the process that
`up` starts to keep the run, dies before `down`, the containers keep running and holding memory.

1. Run `bun verify status`, and note `data.instance`, the run's ID.
2. Run `docker ps -a --filter name=impz-verify-<instance>` with that ID.
3. Run `docker rm -f` on each container it lists, then `bun verify down`.

# ZFS, NixOS, agent Go and CI

These four areas each have a test layer outside the plain `bun test` run. This file says which layer
to use for a change and what each one proves; the scripts and their tests show how each layer runs.

## ZFS

Test the ZFS backend against the in-memory `zfs` fake,
[`buildStubZfs`](../../../../packages/daemon/testing/vm/build-stub-zfs.ts), first. The fake models
datasets, snapshots, clones, promote, deferred destroy and legacy mounts, and it can block, fail or
crash a command and restart, so a test can stop a backend halfway through an operation. Its space
numbers are fixed, and it refuses to unmount a dir that is not itself a mount, as util-linux does.

Write a real-pool test only for behaviour that depends on the kernel module, such as space
accounting or a real mount. Real-pool tests skip until their two gates name a dataset and its mount
dir. Each one makes its own dataset under the mount dir, refuses a dataset that already exists, and
releases only what it made.

Two scripts run the real-pool layer. Each `.sh` runs the TypeScript entry of the same name, which
holds the logic:

- **The real-pool script**, [`test-zfs.ts`](../../../../scripts/test-zfs.ts), makes a throwaway
  sparse-file pool, runs the ZFS backend's tests with both gates set, and destroys the pool on exit
  when `zpool status` proves the pool is its own.
- **The ZFS host script**, [`zfs-host-test.ts`](../../../../scripts/zfs-host-test.ts), runs the
  real-pool script, then runs end-to-end suites on a ZFS-backed dev instance over a second throwaway
  pool, and writes a summary of impd's ZFS timings into the work dir, which it keeps.

Both take the pool properties from
[`readZfsPoolProperties`](../../../../scripts/lib/read-zfs-pool-properties.ts), and read these
settings:

| Setting                       | Script    | What it does                                                                     |
| ----------------------------- | --------- | -------------------------------------------------------------------------------- |
| `IMP_ZFS_TEST_DIR`            | both      | The work dir for the pool files; unset or empty makes a new temp dir             |
| `IMP_ZFS_TEST_GIB`            | real-pool | The size of the pool file                                                        |
| `IMP_ZFS_BENCH_GIB`           | host      | The size of the second pool's file                                               |
| `IMP_ZFS_E2E_SUITES`          | host      | Names the suites to run, as `--only` takes them, in place of the ZFS lane        |
| `IMP_ZFS_SHARD`               | host      | The ZFS lane's share to run, `<n>/<count>`; unset runs the whole lane (`1/1`)    |
| `IMP_ZFS_TEST_UNIT=0`         | host      | Skips the real-pool script, which one CI shard runs on its own                   |
| `IMP_DEV_PORT_OFFSET`         | host      | The port offset of the `imp-zfs` dev instance                                    |
| `IMP_ZFS_ALLOW_UIOMOVE_BUG=0` | host      | Refuses a module with the zfs_uiomove bug, which the runner's Ubuntu module has  |
| `IMP_ZFS_MODULE_VERSION_FILE` | both      | Where the loaded module's version is read, so the tests can fake a loaded module |

Both scripts have tests that run them against stub binaries; a change to either script's cleanup
extends those tests. A test that stubs `bun` runs the entry with its own Bun, because the wrapper
would find the stub on `PATH`. The host script's tests point `IMP_ROOT` at a tree of stub scripts,
which the entry runs in place of the checkout's `dev.sh`, `test-e2e.sh` and `test-zfs.sh`.

## NixOS

The flake has two checks of the NixOS module:

- **The evaluation check** runs nix-unit cases and then builds the generated files and greps them.
  nix-unit runs only the attributes whose names start with `test`, so each case is named `"test …"`.
  Hosts that several cases read sit in the file's `let`, because each host is a full NixOS
  evaluation, and a comment above each such case states the host and the option its expected value
  depends on. A negative grep passes only on grep's exit status 1, so an unreadable file fails the
  check.
- **The VM check** is one NixOS test with two nodes. Each scenario that changes the host restores it
  and checks the restore, so the scenarios after it start from the started host. Every firewall
  there drops without a reject, so a dropped connection shows as the `timeout` command's exit: 124
  on a node, and 143 inside the stand-in image, whose busybox `timeout` kills with SIGTERM.

The format check runs `nix fmt -- --check`, and a local `nixfmt` matches it only at the pinned
nixpkgs' version.

## Agent Go

An agent timer that a test must shorten sits on an unexported field, which the constructor sets from
the package's constant. A test in the same package changes the field before it starts the work,
nothing outside the package changes it, and one test per package checks the constructor's default.

The session history's replay is too large to pin inline, so its golden test pins the replay's length
and SHA-256 over a seeded input that the test file generates. The input changes only by an edit to
that file, and a changed replay means editing the pinned values on purpose.

A recorder in place of an own package's function fits when that package's kernel edge has its own
tests and the test asserts only whether and how the call was made. The server's freeze tests record
disk grow calls this way, because the disk package tests the sysfs and ioctl edge itself.

## CI

Every command in the skill's table runs in a CI job, in
[`ci.yml`](../../../../.github/workflows/ci.yml) or
[`nix.yml`](../../../../.github/workflows/nix.yml). Two facts about those jobs matter when you
change a test:

- The end-to-end work runs as three groups on KVM runners, and the required `e2e` check passes only
  when every group passes. One group also runs the host networking tests as root, and one sets up
  the dashboard's browser. A unit test pins these roles against the workflow file, so a change to
  the groups changes both.
- The ZFS work runs as three `zfs-shard` jobs, and the required `zfs` check passes only when every
  shard passes. Each shard installs ZFS on its runner and runs its suites; one also runs
  `scripts/test-zfs.sh`. A ZFS failure on a pull request shows there and nowhere else, and a unit
  test pins the shards against the workflow file.

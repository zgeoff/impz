# ZFS, NixOS, agent Go and CI

Test the ZFS backend against the fake first. A real pool costs root, the zfs module and minutes per
run, so use one only for what the kernel module decides. When this host lacks what a ZFS, NixOS or
root-only test needs, push the branch and read the CI check that runs it, as [CI](#ci) shows.

- [ZFS](#zfs)
- [NixOS](#nixos)
- [Agent Go](#agent-go)
- [CI](#ci)

## ZFS

- Test the ZFS backend against the in-memory `zfs` fake,
  [`buildStubZfs`](../../../../packages/daemon/src/test-utils/vm/build-stub-zfs.ts), first. The fake
  models datasets, snapshots, clones, promote, deferred destroy and legacy mounts. To stop the
  backend halfway through an operation, hold a command with `blockBefore`, fail one with `failOnce`,
  or crash the backend with `crashBefore`, then start it again with `restart`.
- Never assert space figures against the fake: they stay the same whatever the test writes. The fake
  also refuses to unmount a folder that is not itself a mount, as util-linux does.
- Write a real-pool test only for behaviour that the kernel module decides, such as space accounting
  or a real mount. Put it beside the backend's other tests in
  [`packages/daemon/src/vm/storage/zfs/`](../../../../packages/daemon/src/vm/storage/zfs/).
- Mark the test `test.skipIf(readZfsTestPool() === null)`.
  [`readZfsTestPool`](../../../../packages/daemon/src/test-utils/vm/read-zfs-test-pool.ts) reads the
  parent dataset from `IMP_TEST_ZFS_ROOT` and the parent folder from `IMP_TEST_ZFS_DIR`, and returns
  null until both are set.
- Make the test's dataset with
  [`createZfsTestDataset`](../../../../packages/daemon/src/test-utils/vm/create-zfs-test-dataset.ts),
  passing it the non-null result of `readZfsTestPool()`. It makes a child dataset, mounts it in a
  new folder under the parent folder, refuses a dataset that already exists, and removes only what
  it made.
- Run the real-pool tests with [`scripts/test-zfs.sh`](../../../../scripts/test-zfs.sh), as root
  with the zfs module loaded. It makes a throwaway pool in a sparse file and sets both variables. On
  exit, it destroys the pool only when `zpool status` shows its own pool file.
- Run [`scripts/zfs-host-test.sh`](../../../../scripts/zfs-host-test.sh) to run the end-to-end
  suites on a ZFS-backed dev instance. It needs sudo, Docker, KVM and the zfs module. It runs
  `test-zfs.sh` on one throwaway pool, then the suites on a second one.

Each `.sh` runs the TypeScript entry of the same name,
[`test-zfs.ts`](../../../../scripts/test-zfs.ts) or
[`zfs-host-test.ts`](../../../../scripts/zfs-host-test.ts). Set the settings below only for a run of
these scripts: the root preload deletes them in a unit test. Mind the order of the words:
`IMP_ZFS_TEST_DIR` is the scripts' work folder, and `IMP_TEST_ZFS_DIR` is a test's parent folder.

| Setting                       | Script             | What it does                                                                                |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `IMP_ZFS_TEST_DIR`            | both               | The work folder for the pool files. Unset or empty, the script makes a new temporary one    |
| `IMP_ZFS_TEST_GIB`            | `test-zfs.sh`      | The size of the pool file                                                                   |
| `IMP_ZFS_BENCH_GIB`           | `zfs-host-test.sh` | The size of the suites' pool file                                                           |
| `IMP_ZFS_E2E_SUITES`          | `zfs-host-test.sh` | VM suites to run on the ZFS backend, as `e2e/test-e2e.sh --only` takes them                 |
| `IMP_ZFS_SHARD`               | `zfs-host-test.sh` | The share of the ZFS suites to run, as `<n>/<count>`. With neither this nor the suites, all |
| `IMP_ZFS_TEST_UNIT`           | `zfs-host-test.sh` | `0` skips the first `test-zfs.sh` run. CI sets it, and runs `test-zfs.sh` in its own step   |
| `IMP_DEV_PORT_OFFSET`         | `zfs-host-test.sh` | The port offset of the `imp-zfs` dev instance                                               |
| `IMP_ZFS_ALLOW_UIOMOVE_BUG`   | `zfs-host-test.sh` | `0` refuses a module without the [zfs_uiomove fix](../../../../docs/architecture/host.md)   |
| `IMP_ZFS_MODULE_VERSION_FILE` | both               | Where the loaded module's version is read, so a test can fake a loaded module               |

When a CI row sets both `IMP_ZFS_SHARD` and `IMP_ZFS_E2E_SUITES`, the script runs that share of the
ZFS suites and the named VM suites.

- When you change either script's cleanup, extend its tests,
  [`test-zfs.test.ts`](../../../../scripts/test-zfs.test.ts) or
  [`zfs-host-test.test.ts`](../../../../scripts/zfs-host-test.test.ts), which run it against stub
  binaries.
- In a test that stubs `bun`, run the entry with `process.execPath`, because the `.sh` wrapper would
  find the stub on `PATH`.
- Point `IMP_ROOT` at a folder of stub scripts to test `zfs-host-test.ts`. It then runs them in
  place of the checkout's `dev.sh`, `test-e2e.sh` and `test-zfs.sh`.

## NixOS

- Add a test case that evaluates the NixOS module and checks an option to
  [`eval.nix`](../../../../deploy/nixos/tests/eval.nix). Start its attribute name with `test`,
  because nix-unit runs only those.
- When several cases read one evaluated NixOS configuration, define that configuration once in the
  `let` of `eval.nix`, because each configuration costs a full evaluation. Above each case that
  reads it, write a comment that names the configuration and the option its expected value depends
  on.
- In `eval.nix`, treat a `grep` that must find nothing as passing only on exit status 1. Status 2
  means grep could not read the file, and must fail the check.
- In [`vm.nix`](../../../../deploy/nixos/tests/vm.nix), make each scenario that changes the host
  restore it and check the restore, so the next scenario starts from the host as the test first
  started it.
- In `vm.nix`, expect a connection that a firewall drops to end with the exit status of `timeout`.
  On a test node it is 124. Inside the container image that stands in for impd's host image, it is
  143, because that image's busybox `timeout` kills with SIGTERM.
- Run the format check with `nix fmt -- --check`. A local `nixfmt` matches it only at the version of
  the nixpkgs that the flake pins.

## Agent Go

- When a test must shorten a timer of the Go guest agent, keep the timer in an unexported struct
  field that the constructor sets from a constant. Change the field only from a test in the same
  package, before the work starts. Check the constructor's default value of each such field in one
  test of that package.
- When a golden output is too large to write inline, generate a seeded input in the test file and
  assert the output's length and SHA-256, as
  [`screen_golden_test.go`](../../../../agent/internal/feature/session/screen_golden_test.go) does.
  When the output changes on purpose, copy the new length and hash from the failing test.
- When the code under test calls a function of another agent package, and that package's own tests
  cover its kernel calls, pass a fake that records each call, and assert on the recorded calls.
  `fakeGrow` in [`freeze_test.go`](../../../../agent/internal/server/freeze_test.go) does this for
  the disk package's grow.

## CI

Find the check that runs a test this host cannot:

| Tests                              | Workflow                                           | Check                                     |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| End-to-end suites, host networking | [`ci.yml`](../../../../.github/workflows/ci.yml)   | `e2e`, from the `e2e-group` jobs; group 2 |
| ZFS suites and `test-zfs.sh`       | `ci.yml`                                           | `zfs`, from the `zfs-shard` jobs; shard 1 |
| Agent Go, root-only included       | `ci.yml`                                           | `go`                                      |
| NixOS module evaluation and VMs    | [`nix.yml`](../../../../.github/workflows/nix.yml) | `eval` and `vm`                           |

- The `e2e` and `zfs` checks pass only when every job of their matrix passes, so open the failed
  job's log, not the summary check's.
- When you change the end-to-end groups in `ci.yml`, change
  [`ci-groups.test.ts`](../../../../packages/e2e-harness/src/ci-groups.test.ts) too. It fails when
  the groups in the two files differ.

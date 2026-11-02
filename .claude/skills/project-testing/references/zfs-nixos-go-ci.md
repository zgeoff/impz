# ZFS, NixOS, agent Go and CI

Test the ZFS backend against the fake first, and a real pool only for what the kernel module
decides. Run the NixOS, ZFS and root-only layers in CI when this host lacks what they need.

## ZFS

- Test the ZFS backend against the in-memory `zfs` fake,
  [`buildStubZfs`](../../../../packages/daemon/testing/vm/build-stub-zfs.ts), first. The fake models
  datasets, snapshots, clones, promote, deferred destroy and legacy mounts. It can make a command
  block, fail or crash the backend, and then start the backend again, so a test can stop the backend
  halfway through an operation.
- Expect the fake's space figures to stay the same whatever the test writes. The fake also refuses
  to unmount a folder that is not itself a mount, as util-linux does.
- Write a real-pool test only for behaviour that the kernel module decides, such as space accounting
  or a real mount. Put it beside the backend's other tests in
  [`packages/daemon/src/vm/storage/zfs/`](../../../../packages/daemon/src/vm/storage/zfs/).
- Make the test's dataset with
  [`createZfsTestDataset`](../../../../packages/daemon/testing/vm/create-zfs-test-dataset.ts). It
  makes a dataset under the folder that `IMP_TEST_ZFS_DIR` names, refuses one that already exists,
  and releases only what it made. The test skips until `IMP_TEST_ZFS_ROOT` and `IMP_TEST_ZFS_DIR`
  are set.
- Run the real-pool tests with [`scripts/test-zfs.sh`](../../../../scripts/test-zfs.sh), as root
  with the zfs module loaded. It makes a throwaway pool in a sparse file, sets both variables, and
  destroys the pool on exit only when `zpool status` proves the pool is its own.
- Run [`scripts/zfs-host-test.sh`](../../../../scripts/zfs-host-test.sh) to test the end-to-end
  suites on a ZFS-backed dev instance. It needs sudo, Docker, KVM and the zfs module. It runs
  `test-zfs.sh` first, then the suites on a second throwaway pool, and keeps its work folder with a
  summary of impd's ZFS timings.

Each `.sh` runs the TypeScript entry of the same name,
[`test-zfs.ts`](../../../../scripts/test-zfs.ts) or
[`zfs-host-test.ts`](../../../../scripts/zfs-host-test.ts), and both entries point at this table for
the settings they read:

| Setting                       | Script             | What it does                                                                                           |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| `IMP_ZFS_TEST_DIR`            | both               | The work folder for the pool files; unset or empty makes a new temp folder                             |
| `IMP_ZFS_TEST_GIB`            | `test-zfs.sh`      | The size of the pool file                                                                              |
| `IMP_ZFS_BENCH_GIB`           | `zfs-host-test.sh` | The size of the second pool's file                                                                     |
| `IMP_ZFS_E2E_SUITES`          | `zfs-host-test.sh` | The VM suites to run, in the form `--only` takes; set alone, they run in place of the ZFS lane         |
| `IMP_ZFS_SHARD`               | `zfs-host-test.sh` | The shard of the ZFS lane to run, as `<n>/<count>`; with neither setting, the whole lane runs          |
| `IMP_ZFS_TEST_UNIT=0`         | `zfs-host-test.sh` | Skips `test-zfs.sh`, which one CI shard runs                                                           |
| `IMP_DEV_PORT_OFFSET`         | `zfs-host-test.sh` | The port offset of the `imp-zfs` dev instance                                                          |
| `IMP_ZFS_ALLOW_UIOMOVE_BUG=0` | `zfs-host-test.sh` | Refuses a module with the zfs_uiomove bug, which the runner's Ubuntu module has; the default allows it |
| `IMP_ZFS_MODULE_VERSION_FILE` | both               | Where the loaded module's version is read, so a test can fake a loaded module                          |

- When you change either script's cleanup, extend its tests,
  [`test-zfs.test.ts`](../../../../scripts/test-zfs.test.ts) or
  [`zfs-host-test.test.ts`](../../../../scripts/zfs-host-test.test.ts), which run it against stub
  binaries.
- In a test that stubs `bun`, run the entry with `process.execPath`, because the `.sh` wrapper would
  find the stub on `PATH`.
- Point `IMP_ROOT` at a tree of stub scripts to test `zfs-host-test.ts`, which then runs them in
  place of the checkout's `dev.sh`, `test-e2e.sh` and `test-zfs.sh`.

## NixOS

- Add a case of the NixOS module's evaluation to
  [`eval.nix`](../../../../deploy/nixos/tests/eval.nix), and start its attribute name with `test`,
  because nix-unit runs only those.
- Put a host that several cases read in the file's `let`, because each host is a full NixOS
  evaluation. Above each case that reads one, write a comment that names the host and the option its
  expected value depends on.
- Pass a negative grep in that file only on grep's exit status 1, so an unreadable file fails the
  check.
- In [`vm.nix`](../../../../deploy/nixos/tests/vm.nix), make each scenario that changes the host
  restore it and check the restore, so the next scenario starts from the host as the test first
  started it.
- Expect a connection that a firewall drops in `vm.nix` to show as the exit status of the `timeout`
  command: 124 on a node, and 143 inside the stand-in image for impd, whose busybox `timeout` kills
  with SIGTERM.
- Run the format check with `nix fmt -- --check`. A local `nixfmt` matches it only at the version of
  the nixpkgs that the flake pins.

## Agent Go

- Put a timer of the Go guest agent that a test must shorten on an unexported field, which the
  constructor sets from a constant. Change the field only from a test in the same package, before
  the work starts, and check the constructor's default in one test per package.
- Pin a golden output too large to write inline by its length and SHA-256 over a seeded input that
  the test file makes, as
  [`screen_golden_test.go`](../../../../agent/internal/feature/session/screen_golden_test.go) does.
  When the output changes on purpose, copy the new length and hash from the failing test.
- Use a recorder in place of a function from another package of the agent when that package tests
  its own kernel calls, and the test checks only whether and how the call was made. The server's
  freeze tests record disk grow calls this way, because the disk package tests its sysfs and ioctl
  calls itself.

## CI

- The end-to-end work runs as the `e2e-group` matrix in
  [`ci.yml`](../../../../.github/workflows/ci.yml), and the required `e2e` check passes only when
  every group passes. Some groups have roles, such as the one that runs the host networking tests.
  [`ci-groups.test.ts`](../../../../packages/e2e-harness/src/ci-groups.test.ts) pins the groups
  against the workflow file, so a change to the groups changes both.
- The ZFS work runs as the `zfs-shard` matrix, and the required `zfs` check passes only when every
  shard passes. Each shard installs ZFS on its runner and runs its suites, and one also runs
  [`scripts/test-zfs.sh`](../../../../scripts/test-zfs.sh). A ZFS failure on a pull request shows
  there and nowhere else.

---
name: project-testing
description:
  "imp's test facts beside the shared testing skill: which command runs which tests and what each
  needs, the lanes, the root preload's resets, ports, git and tmpfs in tests, and booting impd. Load
  it beside testing before you design, write, run or review a test in this repo."
metadata:
  kind: rule-set
---

# imp tests

## References

- [Preloads and utils](./references/preloads-and-utils.md): the root and dashboard preloads, how
  each kind of util releases its resource, and what a daemon `setupTest()` returns.
- [Stand-ins](./references/stand-ins.md): the kinds of stand-in and when to use each, booting impd
  and its harnesses, Bun's timer and transport facts, and the broker's test upstreams.
- [End to end](./references/e2e.md): writing a journey, the baseline reset, sets and groups, and
  host safety.
- [ZFS, NixOS, Go and CI](./references/zfs-nixos-go-ci.md): the ZFS fake or a real pool, the NixOS
  checks, agent Go timer and golden tests, and the CI facts a test change touches.

## Facts

| Fact       | Where                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lanes      | [`rig.config.ts`](../../../rig.config.ts): each lane's suffix, time limit and start hook; [`packages/daemon/e2e/`](../../../packages/daemon/e2e/) holds the e2e and zfs journeys                            |
| Test utils | [`packages/shared/src/test-utils/`](../../../packages/shared/src/test-utils/) for a util that knows nothing about imp, then the `src/test-utils/` folder of the package whose code the util starts or fakes |

## Departures

- Run the VM and ZFS journeys through [`test-e2e.sh`](../../../scripts/test-e2e.sh) and
  [`zfs-host-test.sh`](../../../scripts/zfs-host-test.sh), never `rig e2e` or `rig zfs`, in place of
  the rig run in the testing skill's
  [Where each test runs](../testing/references/slow-tests.md#where-each-test-runs) section. A
  journey is one test file under `packages/daemon/e2e/`, and it drives a dev instance: a running
  impd and its VMs. rig starts no dev instance. Each harness starts its own. To run one journey by
  hand, start a dev instance with `scripts/dev/dev.sh up` first.
- Keep each `test()` in a journey under 60 s, in place of the 15 s of the e2e lane in
  [Where each test runs](../testing/references/slow-tests.md#where-each-test-runs). A journey drives
  a real VM. `rig.config.ts` declares the `e2e` and `zfs` lanes only to hold the 60 s, which
  `zgeoff/max-test-timeout` reads.

## Commands and what they need

Each lane but `e2e` and `zfs` runs through its `test:<lane>` script in the root
[`package.json`](../../../package.json), which calls `rig <lane>`. A lane's files carry its suffix,
such as `.host.test.ts`. Pull no image in a headscale or pebble test: those lanes' start hook pulls
them before the first test.

Run a command only where its needs are met. When this host lacks them, push your branch, and read
the result of the row's CI job: `eval` and `vm` are in
[`nix.yml`](../../../.github/workflows/nix.yml), the others in
[`ci.yml`](../../../.github/workflows/ci.yml).

| Tests                   | Command                                                                                | Needs                                                        | CI job         |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- |
| Unit                    | `bun run test <path>`; `bun run test` for all                                          | bash, git, jq, tar, truncate, mkfs.ext4                      | `checks-unit`  |
| Dashboard components    | `bun run test:dashboard`                                                               | bash, tar                                                    | `checks-lanes` |
| Agent Go                | `scripts/test-go.sh`                                                                   | Go from `agent/go.mod`                                       | `go`           |
| ksm-exec                | `cd host/ksm-exec && go test -race ./...`                                              | Linux 6.7 or later with KSM; the exec tests skip elsewhere   | `go`           |
| Agent Go, root-only     | `cd agent && sudo -E env "PATH=$PATH" go test -tags root -race ./...`                  | root, a writable cgroup2                                     | `go`           |
| uffd-handler, root-only | `cd host/uffd-handler && sudo -E env "PATH=$PATH" go test -tags root -race ./...`      | root                                                         | `go`           |
| Host networking lane    | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun run test:host`                      | root, `nft`, `iptables`, `ip6tables`, `ip`, `ping`, `sysctl` | `e2e-group`    |
| ACME issuer lane        | `bun run test:pebble`                                                                  | Docker                                                       | `checks-lanes` |
| Headscale join lane     | `bun run test:headscale`                                                               | Docker, and the network for the client's packages            | `checks-lanes` |
| Docker build lane       | `bun run test:docker`                                                                  | Docker with buildx                                           | `checks-lanes` |
| Small filesystem lane   | `IMP_TEST_SMALL_FS=<dir> bun run test:small-fs`                                        | a 4 GiB loop-mounted XFS at `<dir>`; a tiny tmpfs fails      | `checks-lanes` |
| VM end to end lane      | `scripts/test-e2e.sh [--only <suites> \| --group <1-4>] [--clean \| --reuse] [--keep]` | KVM, Docker; `--help` lists the suites and their needs       | `e2e-group`    |
| One end-to-end journey  | `bun test --config=packages/daemon/e2e/bunfig.toml ./packages/daemon/e2e/<file>`       | a dev instance from `scripts/dev/dev.sh up`                  | none           |
| NixOS module evaluation | `nix build -L --no-link .#checks.x86_64-linux.eval`                                    | Nix with flakes                                              | `eval`         |
| NixOS VMs               | `nix build -L --no-link .#checks.x86_64-linux.vm`                                      | Nix with the `kvm` and `nixos-test` system features          | `vm`           |
| ZFS on a real pool      | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                                            | root, the zfs module, `zpool`                                | `zfs-shard`    |
| ZFS lane, host with VMs | `scripts/zfs-host-test.sh`, with `IMP_ZFS_SHARD=<n>/<count>` for one shard             | sudo, Docker, KVM, the zfs module                            | `zfs-shard`    |

## Where a test lives

- Search both folders in the Test utils row of [Facts](#facts) before you write a test util, and put
  a new one in the folder that row names for it.
- Put a client or MCP server test that needs a real impd beside the module it tests, and boot impd
  by the rule in [Boundaries](#boundaries), from `@impz/daemon/test-utils`. Keep `@impz/daemon` a
  dev dependency of `@impz/client` and `@impz/mcp`, so neither published build depends on impd.
- Put a test of the end-to-end or bootstrap harness in
  [`packages/e2e-harness/`](../../../packages/e2e-harness/). It runs in the unit run, with no KVM.
  Keep [`packages/daemon/e2e/`](../../../packages/daemon/e2e/) for the journeys and their fixtures.
- Name a journey file by the rule at the top of the [End to end reference](./references/e2e.md).
- Test a guest's disk contents in a journey. A test impd runs no guest, and its imp disks start
  empty.
- Give a Go test that needs root the `root` build tag.
- Put only the cases that need a lane's real system in the lane file, such as `<name>.host.test.ts`.
  Keep a case that needs none of it in `<name>.test.ts`.

## Lanes

- Expect the real-pool ZFS tests in the unit run to skip until `IMP_TEST_ZFS_ROOT` and
  `IMP_TEST_ZFS_DIR` are set, and the small-filesystem tests to skip until `IMP_TEST_SMALL_FS` is.
  [`test-zfs.sh`](../../../scripts/test-zfs.sh) sets the two ZFS variables for its pool.
- Skip a host networking test with `test.skipIf(!probeUnshare([...]))`, from
  [`probe-unshare.ts`](../../../packages/daemon/src/test-utils/host-net/probe-unshare.ts). It skips
  where the test can't make a network namespace, such as without root. `IMP_HOST_TESTS=required`,
  which CI sets, turns that skip into a failure.
- When you add a lane, declare it in `rig.config.ts` with its limit, its suffix when it differs from
  `.<lane>`, and a start hook when its system needs one. Add a `test:<lane>` script that runs
  `rig <lane>`, and add it to a CI job by the rules of the `project-ci-design` skill.
- Before you add or slow a ZFS-lane suite, read [CI](./references/zfs-nixos-go-ci.md#ci) for its
  shards.

## The root preload

- Set an `IMP_*` variable, which impd reads as a setting, with
  [`updateEnv`](../../../packages/shared/src/test-utils/update-env.ts) before `setupTest()`. The
  [root preload](../../../packages/shared/src/test-utils/preload.ts) deletes every `IMP_*` variable
  the shell passed.
- Expect the root preload to keep the variables that run a lane's tests or turn their skip into a
  failure:
  - `IMP_HOST_TESTS`;
  - `IMP_TEST_SMALL_FS`;
  - `IMP_TEST_ZFS_ROOT` and `IMP_TEST_ZFS_DIR`.
- Expect every child process to inherit `NO_PROXY=*` from the root preload. It keeps Bun's `fetch`
  from sending a loopback request through the shell's `HTTPS_PROXY`. To send a child's requests
  through a proxy, clear `NO_PROXY` in that child's environment, or pass curl `--noproxy ''`.
- When state leaks from one test into the next, add its reset to the `afterEach` in
  [`register-run-hooks.ts`](../../../packages/shared/src/test-utils/register-run-hooks.ts), which
  the root preload registers.
- Repeat a failing order with the `--seed=<n>` that the run prints. The root `bunfig.toml` runs
  files and tests in random order.

## Boundaries

- Start a stand-in server, a local test server in place of the remote one, for a request that MSW
  (Mock Service Worker) never sees. Read why for each case in
  [Kinds of stand-in](./references/stand-ins.md#kinds-of-stand-in):
  - a `fetch` to loopback or to a unix socket;
  - a request from a `node:http` client;
  - a WebSocket.
- Look for a stand-in in [Stand-ins](./references/stand-ins.md) before you write one.
- Boot a real impd with
  [`startTestImpd`](../../../packages/daemon/src/test-utils/start-test-impd.ts), which runs
  production's startup through `createImpd` on the stand-ins. Leave its `defaultDiskBytes` at 0: its
  stand-in storage copies each disk in full, and a 32 GiB disk takes minutes.
- Pass the stub clock of `startTestImpd` directly to each component that keeps a clock of its own.
  Find those components, and where the clock comes from, in
  [Booting impd](./references/stand-ins.md#booting-impd).

## Host resources

- Take ports from the port picker,
  [`claimFreePorts`](../../../packages/shared/src/test-utils/claim-free-ports.ts). It holds each
  port until the test ends.
- Make the temporary folder of a test that needs FIEMAP or another disk feature under `/var/tmp`,
  which sits on disk. `tmpdir()` is a tmpfs on some hosts, and a tmpfs has no extents for FIEMAP to
  map. Make it with `mkdtemp`, and remove it in `onTestFinished`.
- Run git through the helpers in `@impz/e2e-harness/git-env`
  ([`git-env.ts`](../../../packages/e2e-harness/src/git-env.ts)). A git hook leaks `GIT_DIR`, and a
  child git then works on this checkout, whatever path you pass to `-C`.

## End to end

- Never run two suites at once on one dev instance. A suite is an entry in
  [`suites.ts`](../../../packages/e2e-harness/src/suites.ts) that lists journey files. The harness
  resets the instance after each journey, so the other suite loses its imps. Give each suite its own
  instance, with its own `IMP_DEV_NAME` and `IMP_DEV_PORT_OFFSET`.
- Follow the steps in [Writing a journey](./references/e2e.md#writing-a-journey).

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

Write, place and run imp's tests by the testing skill, with the facts below for this repo. Hand back
each test command you ran and its result, or the CI job that ran a command this host can't.

The traps:

- Set an impd setting with `updateEnv`. The [root preload](#the-root-preload) deletes your shell's
  `IMP_*` variables.
- Run git through the [git helpers](#host-resources). A git hook leaks `GIT_DIR` into a child git.
- Test a guest's disk contents in an end-to-end journey. A test impd runs no guest, and its imp
  disks start empty.

## Key rules

- [Departures](#departures): plain `bun test`; CI sets `--parallel`.
- [Commands and what they need](#commands-and-what-they-need): run a command where its needs are
  met, else read its CI job.
- [Where a test lives](#where-a-test-lives): beside its module; journeys in `packages/daemon/e2e/`.
- [Lanes](#lanes): skips, limits and ZFS shards.
- [The root preload](#the-root-preload): `updateEnv`; reset a leak in a preload `afterEach`.
- [Boundaries](#boundaries): a real stand-in server where MSW can't see; `startTestImpd`.
- [Host resources](#host-resources): ports, `/var/tmp` and git.
- [End to end](#end-to-end): one suite at a time per dev instance.

## References

- [Preloads and utils](./references/preloads-and-utils.md): the root and dashboard preloads, the two
  kinds of util for cleanup order, and what a daemon `setupTest()` returns.
- [Stand-ins](./references/stand-ins.md): the kinds of stand-in and when to use each, booting impd
  and its harnesses, Bun's timer and transport facts, and the broker's test upstreams.
- [End to end](./references/e2e.md): writing a journey, the baseline reset, sets and groups, and
  host safety.
- [ZFS, NixOS, Go and CI](./references/zfs-nixos-go-ci.md): the ZFS fake or a real pool, the NixOS
  checks, agent Go timer and golden tests, and the CI facts a test change touches.

## Departures

- Run the unit tests with plain `bun test`, with no `--parallel`. The testing skill's
  [run mode section](../testing/references/slow-tests.md#the-run-mode-and-workers) asks for the
  `rig unit` runner. Here the `checks-unit` job of [`ci.yml`](../../../.github/workflows/ci.yml)
  passes `--parallel=2 --no-isolate` itself: four workers outgrow the job's memory cap.

## Commands and what they need

A lane is a set of tests that need one real system, such as Docker. Its tests sit in files with its
suffix, such as `.host.test.ts`, and its `test:<lane>` script in the root
[`package.json`](../../../package.json) runs them. The `lanes` map of `zgeoff/max-test-timeout` in
[`.oxlintrc.json`](../../../.oxlintrc.json) holds each lane's time limit.

Run a command only where its needs are met. When this host lacks them, push your branch, and read
the result of the CI job that runs the command. CI runs every row except "One end-to-end journey",
in [`ci.yml`](../../../.github/workflows/ci.yml) and
[`nix.yml`](../../../.github/workflows/nix.yml).

| Tests                   | Command                                                                                | Needs                                                        |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Unit                    | `bun test <path>`; `bun test` for all                                                  | bash, git, jq, tar, truncate, mkfs.ext4                      |
| Dashboard components    | `bun run test:dashboard`                                                               | bash, tar                                                    |
| Agent Go                | `scripts/test-go.sh`                                                                   | Go from `agent/go.mod`                                       |
| ksm-exec                | `cd host/ksm-exec && go test -race ./...`                                              | Linux 6.7 or later with KSM; the exec tests skip elsewhere   |
| Agent Go, root-only     | `cd agent && sudo -E env "PATH=$PATH" go test -tags root -race ./...`                  | root, a writable cgroup2                                     |
| uffd-handler, root-only | `cd host/uffd-handler && sudo -E env "PATH=$PATH" go test -tags root -race ./...`      | root                                                         |
| Host networking lane    | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun run test:host`                      | root, `nft`, `iptables`, `ip6tables`, `ip`, `ping`, `sysctl` |
| ACME issuer lane        | `bun run test:pebble`                                                                  | Docker                                                       |
| Headscale join lane     | `bun run test:headscale`                                                               | Docker, and the network for the client's packages            |
| Docker build lane       | `bun run test:docker`                                                                  | Docker with buildx                                           |
| Small filesystem lane   | `IMP_TEST_SMALL_FS=<dir> bun run test:small-fs`                                        | a 4 GiB loop-mounted XFS at `<dir>`; a tiny tmpfs fails      |
| VM end to end lane      | `scripts/test-e2e.sh [--only <suites> \| --group <1-4>] [--clean \| --reuse] [--keep]` | KVM, Docker; `--help` lists the suites and their needs       |
| One end-to-end journey  | `bun test --config=packages/daemon/e2e/bunfig.toml ./packages/daemon/e2e/<file>`       | a dev instance from `scripts/dev/dev.sh up`                  |
| NixOS module evaluation | `nix build -L --no-link .#checks.x86_64-linux.eval`                                    | Nix with flakes                                              |
| NixOS VMs               | `nix build -L --no-link .#checks.x86_64-linux.vm`                                      | Nix with the `kvm` and `nixos-test` system features          |
| ZFS on a real pool      | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                                            | root, the zfs module, `zpool`                                |
| ZFS lane, host with VMs | `scripts/zfs-host-test.sh`, with `IMP_ZFS_SHARD=<n>/<count>` for one shard             | sudo, Docker, KVM, the zfs module                            |

## Where a test lives

- Look for a test util in
  [`packages/shared/src/test-utils/`](../../../packages/shared/src/test-utils/) first, then in the
  `src/test-utils/` folder of the package you test. Put a new util in that package's folder.
- Put a client or MCP server test that needs a real impd beside the module it tests, and boot impd
  with [`startTestImpd`](../../../packages/daemon/src/test-utils/start-test-impd.ts) from
  `@impz/daemon/test-utils`. Keep `@impz/daemon` a dev dependency of `@impz/client` and `@impz/mcp`,
  so neither published build depends on impd.
- Put a test of the end-to-end or bootstrap harness in
  [`packages/e2e-harness/`](../../../packages/e2e-harness/). It runs in the unit run, with no KVM.
  Keep [`packages/daemon/e2e/`](../../../packages/daemon/e2e/) for the suites and their fixtures.
- Name an end-to-end journey file by the rule at the top of [End to end](./references/e2e.md).
- Give a Go test that needs root the `root` build tag.
- Put only the cases that need a lane's real system in the lane file, such as `<name>.host.test.ts`.
  Keep a case that needs none of it in `<name>.test.ts`.

## Lanes

- Expect the real-pool ZFS tests in the unit run to skip until `IMP_TEST_ZFS_ROOT` and
  `IMP_TEST_ZFS_DIR` are set, and the small-filesystem tests to skip until `IMP_TEST_SMALL_FS` is.
- Expect a host networking test to skip where it can't make a network namespace, such as without
  root. `IMP_HOST_TESTS=required`, which CI sets, turns that skip into a failure.
- When you add a lane, add its key to the `lanes` map, and a `test:<lane>` script that passes the
  same limit to `bun test` with `--timeout`.
- Keep a test in a VM journey file under the limit of the `e2e` key, and one in a ZFS journey file,
  `<kind>-<journey>.zfs.test.ts`, under the limit of the `zfs` key. `zgeoff/max-test-timeout` fails
  a timeout above it.
- When you add or slow a ZFS-lane suite, update its `seconds` in
  [`suites.ts`](../../../packages/e2e-harness/src/suites.ts), counting the build of any image only
  it needs. CI splits the lane into shards, longest first, by that figure.
- Expect a CI ZFS shard to also run the VM suites in `IMP_ZFS_E2E_SUITES` on the ZFS backend. Those
  suites' journey files keep the `e2e` limit.

## The root preload

- Set an impd setting with [`updateEnv`](../../../packages/shared/src/test-utils/update-env.ts)
  before `setupTest()`. The [root preload](../../../packages/shared/src/test-utils/preload.ts)
  deletes every `IMP_*` variable the shell passed.
- Expect the root preload to keep the run gates, the variables that turn the lanes on:
  - `IMP_HOST_TESTS`;
  - `IMP_TEST_SMALL_FS`;
  - `IMP_TEST_ZFS_ROOT` and `IMP_TEST_ZFS_DIR`.
- Expect every child process to inherit `NO_PROXY=*` from the root preload. It keeps Bun's `fetch`
  from sending a loopback request through the shell's `HTTPS_PROXY`. When a test wants a child to
  use a proxy, clear `NO_PROXY` in that child's environment, or pass curl `--noproxy ''`.
- When state leaks from one test into the next, reset it in an `afterEach` that the root preload
  registers: add it to the one in
  [`register-run-hooks.ts`](../../../packages/shared/src/test-utils/register-run-hooks.ts).
- Repeat a failing order with the `--seed=<n>` that the run prints. The root `bunfig.toml` runs
  files and tests in random order.

## Boundaries

- Start a real stand-in server, a test server in place of the real one, for a request that MSW (Mock
  Service Worker) never sees:
  - a `fetch` to loopback or to a unix socket;
  - a request from a `node:http` client;
  - a WebSocket.
- Look for a stand-in in [Stand-ins](./references/stand-ins.md) before you write one.
- Boot a real impd with
  [`startTestImpd`](../../../packages/daemon/src/test-utils/start-test-impd.ts), which runs
  production's startup through `createImpd` on the stand-ins. It sets `defaultDiskBytes` to 0,
  because its stand-in storage copies a full 32 GiB disk in minutes.
- Pass the stub clock directly to each component that keeps a clock of its own.
  [Booting impd](./references/stand-ins.md#booting-impd) shows how to find them.

## Host resources

- Take ports from the port picker,
  [`claimFreePorts`](../../../packages/shared/src/test-utils/claim-free-ports.ts). It holds each
  port until the test ends.
- Make the temporary folder of a test that needs FIEMAP or another disk feature under `/var/tmp`,
  which sits on disk. `tmpdir()` is a tmpfs on some hosts, and a tmpfs has no extents for FIEMAP to
  map.
- Run git through the helpers in `@impz/e2e-harness/git-env`
  ([`git-env.ts`](../../../packages/e2e-harness/src/git-env.ts)). A git hook leaks `GIT_DIR`, and a
  child git then works on this checkout, whatever path you pass to `-C`.
  - `runGitChecked` for a command that must succeed;
  - `runGitCommand` for one whose exit code you check;
  - `createGitFreeEnv` for the environment of git that you start another way.

## End to end

- Run one suite at a time on one dev instance. The harness resets the instance after each journey,
  so a second suite on the same instance loses its imps and settings.
- Follow the steps in [Writing a journey](./references/e2e.md#writing-a-journey).

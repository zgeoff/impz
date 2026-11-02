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

- [Preloads and utils](./references/preloads-and-utils.md): the root and dashboard preloads, the two
  kinds of util for cleanup order, and what a daemon `setupTest()` returns.
- [Stand-ins](./references/stand-ins.md): the kinds of stand-in and when to use each, booting impd
  and its harnesses, Bun's timer and transport facts, and the broker's test upstreams.
- [End to end](./references/e2e.md): what a run does around each journey, the baseline reset, how to
  write a journey, sets and groups, and host safety.
- [ZFS, NixOS, Go and CI](./references/zfs-nixos-go-ci.md): the ZFS fake or a real pool, the NixOS
  checks, agent Go timer and golden tests, and the CI facts a test change touches.

## Facts

| Fact       | Where                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Lanes      | the `lanes` map of `zgeoff/max-test-timeout` in [`.oxlintrc.json`](../../../.oxlintrc.json)                                          |
| Test utils | [`packages/test-utils/src/`](../../../packages/test-utils/src/), then the `test-utils/` or `testing/` folder of the package you test |

## Departures

- Pass `--parallel=2 --no-isolate` in the `checks-unit` job of
  [`ci.yml`](../../../.github/workflows/ci.yml), not in the `test` script, which stays plain
  `bun test`. The test run section of [testing](../testing/SKILL.md) asks for the flags in the test
  script, with the worker count from the shared worker helper. The comment above `checks-unit`
  records the measurements: four workers outgrow the job's memory cap.

## Commands and what they need

Run a command only where its needs are met. When this host lacks them, push your branch, and read
the result of the CI job that runs the command. CI runs every row but One journey, in
[`ci.yml`](../../../.github/workflows/ci.yml) and [`nix.yml`](../../../.github/workflows/nix.yml).

| Tests                   | Command                                                                            | Needs                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Unit and package        | `bun test <path>`; `bun test` for all                                              | bash, git, jq, tar, truncate, mkfs.ext4                      |
| Dashboard components    | `bun run test:dashboard`                                                           | bash, tar                                                    |
| Agent Go                | `scripts/test-go.sh`                                                               | Go from `agent/go.mod`                                       |
| ksm-exec                | `cd host/ksm-exec && go test -race ./...`                                          | Linux 6.7 or later with KSM; the exec tests skip elsewhere   |
| Agent Go, root-only     | `cd agent && sudo -E env "PATH=$PATH" go test -tags root -race ./...`              | root, a writable cgroup2                                     |
| uffd-handler, root-only | `cd host/uffd-handler && sudo -E env "PATH=$PATH" go test -tags root -race ./...`  | root                                                         |
| Host networking lane    | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun run test:host`                  | root, `nft`, `iptables`, `ip6tables`, `ip`, `ping`, `sysctl` |
| ACME issuer lane        | `bun run test:pebble`                                                              | Docker                                                       |
| Headscale join lane     | `bun run test:headscale`                                                           | Docker, and the network for the client's packages            |
| Docker build lane       | `bun run test:docker`                                                              | Docker with buildx                                           |
| Small filesystem lane   | `IMP_TEST_SMALL_FS=<dir> bun run test:small-fs`                                    | a 4 GiB loop-mounted XFS at `<dir>`; a tiny tmpfs fails      |
| VM end to end lane      | `e2e/test-e2e.sh [--only <suites> \| --group <1-4>] [--clean \| --reuse] [--keep]` | KVM, Docker; `--help` lists the suites and their needs       |
| One journey             | `bun test --config=e2e/bunfig.toml ./e2e/suites/<journey>.e2e.ts`                  | a dev instance that is already up                            |
| NixOS module evaluation | `nix build -L --no-link .#checks.x86_64-linux.eval`                                | Nix with flakes                                              |
| NixOS VMs               | `nix build -L --no-link .#checks.x86_64-linux.vm`                                  | Nix with the `kvm` and `nixos-test` system features          |
| ZFS on a real pool      | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                                        | root, the zfs module, `zpool`                                |
| ZFS lane, host with VMs | `scripts/zfs-host-test.sh`, with `IMP_ZFS_SHARD=<n>/<count>` for one shard         | sudo, Docker, KVM, the zfs module                            |

## Where a test lives

- Put a client or MCP server test that needs a real impd in
  [`packages/integration/`](../../../packages/integration/), not beside its module.
- Put a test of the end-to-end or bootstrap harness in
  [`packages/e2e-harness/`](../../../packages/e2e-harness/). It runs in the unit run, with no KVM.
  Keep [`e2e/`](../../../e2e/) for the suites, their fixtures and the scripts that run them.
- Give a Go test that needs root the `root` build tag.
- Put only the cases that need a lane's real system in the lane file, such as `<name>.host.test.ts`.
  Keep a case that needs none of it in `<name>.test.ts`.

## Lanes

- Expect the real-pool ZFS tests in the unit run to skip until `IMP_TEST_ZFS_ROOT` and
  `IMP_TEST_ZFS_DIR` are set, and the small-filesystem tests to skip until `IMP_TEST_SMALL_FS` is.
- Expect a host networking test to skip where it can't make a network namespace, such as without
  root. `IMP_HOST_TESTS=required`, which CI sets, turns that skip into a failure.
- Pass a lane's limit to `bun test` with `--timeout` in the lane's script, as the `test:*` scripts
  do.
- Expect a VM or ZFS suite to get the limit of the `e2e` key in the `lanes` map. Both `e2e/` lanes
  share it, because `zgeoff/max-test-timeout` reads the lane from the folder.
- When you add or slow a ZFS-lane suite, update its `seconds` in
  [`suites.ts`](../../../packages/e2e-harness/src/suites.ts), counting the build of any image only
  it needs. CI splits the lane into shards, longest first, by that figure.
- Expect a `zfs` shard to also run the VM suites that `IMP_ZFS_E2E_SUITES` names, on the ZFS
  backend. Those tests keep the VM lane's suffix and limit.

## The root preload

- Set an impd setting with [`updateEnv`](../../../packages/test-utils/src/update-env.ts) before
  `setupTest()`. The [root preload](../../../packages/test-utils/src/preload.ts) deletes every
  `IMP_*` variable the shell passed, except the four gates in [Lanes](#lanes).
- Expect every child process to inherit `NO_PROXY=*` from the root preload, which sets it so that
  Bun's `fetch` never sends a loopback request through the shell's `HTTPS_PROXY`. When a test wants
  a child to use a proxy, clear `NO_PROXY` in that child's environment, or pass curl `--noproxy ''`.
- When you fix a leak between tests, fix it in the root preload's resets. The root `bunfig.toml`
  runs files and tests in random order; repeat a failing order with the `--seed=<n>` the run prints.

## Boundaries

- Give a real stand-in server to a `fetch` to loopback or to a unix socket, to a `node:http` client,
  and to a WebSocket. MSW never sees these requests.
- Look for a stand-in in [Stand-ins](./references/stand-ins.md) before you write one.
- Boot a real impd with [`startTestImpd`](../../../packages/daemon/testing/start-test-impd.ts),
  which runs production's startup through `createImpd` on the stand-ins. It sets `defaultDiskBytes`
  to 0, because its storage clones with `copyFile`, and a full 32 GiB disk makes each checkpoint or
  fork take minutes.
- Pass a clock to each component that `createImpd`'s `now` doesn't reach.
  [Booting impd](./references/stand-ins.md#booting-impd) lists them.

## Host resources

- Take ports from [`claimFreePorts`](../../../packages/test-utils/src/claim-free-ports.ts). It holds
  each port until the test ends, so two test processes that run at once never share one.
- Make a folder under `/var/tmp`, never in the checkout, for a test that needs FIEMAP or another
  disk feature. `tmpdir()` is a tmpfs on some hosts.
- Run git through the helpers in [`git-env.ts`](../../../packages/e2e-harness/src/git-env.ts):
  `runGitCommand`, `runGitChecked` or `createGitFreeEnv`. A git hook leaks `GIT_DIR`, and a child
  git then works on this checkout whatever its `-C` says.

## End to end

- Run one suite at a time on one dev instance.
- Expect a journey you run alone to get no baseline reset and no fixture image build. Run its suite
  through `e2e/test-e2e.sh --only <suite>` first when it needs either.
- Register each removal with
  [`registerRemoval`](../../../packages/e2e-harness/src/register-removal.ts) on the line after the
  call that made the thing. Removals run last first, so an imp goes before the template it boots.

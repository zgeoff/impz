---
name: project-testing
description:
  imp's test commands, test layers and harness traps — which run covers which files, what each run
  needs, and the impz-specific traps in the preloads, stand-ins, impd boot and the end-to-end
  harness. Load beside the testing skill whenever you design, write, run, or review tests in this
  repo.
---

# imp tests

The `testing` skill holds the rules. This skill holds only what is particular to imp: the traps that
cost time here, the commands, and the layers they cover. The references hold the detail for one area
each; open one when the task touches its area.

## References

- [preloads-and-utils.md](./references/preloads-and-utils.md): the root and dashboard preloads, the
  two kinds of util for cleanup order, and what a daemon `setupTest()` returns.
- [stand-ins.md](./references/stand-ins.md): the kinds of stand-in and when to use each, booting
  impd and its harnesses, Bun's timer and transport facts, and the broker's test upstreams.
- [e2e.md](./references/e2e.md): what a run does around each journey, what the baseline reset
  covers, how to write a journey, sets and groups, and host safety.
- [zfs-nixos-go-ci.md](./references/zfs-nixos-go-ci.md): when to use the ZFS fake or a real pool,
  the NixOS checks, agent Go timer and golden tests, and the CI facts that a test change touches.

## Traps

- **Cleanup runs first-in, first-out.** `onTestFinished` callbacks run in registration order, and a
  callback that throws skips the ones after it. A util that registers its own cleanup therefore
  releases before anything the test registers after it.
- **Ambient `IMP_*` settings vanish.** The root preload deletes every `IMP_*` variable the shell
  passed, except the run gates in [Layers](#layers), so a developer's settings never reach a unit
  test. Set an impd setting with [`updateEnv`](../../../packages/test-utils/src/update-env.ts)
  before `setupTest()`, which reads it through
  [`readImpEnv`](../../../packages/test-utils/src/read-imp-env.ts).
- **An ambient proxy is turned off.** Bun's `fetch` sends a loopback request through the proxy that
  the shell's `HTTPS_PROXY` names, and an older Bun keeps that proxy after the variable is deleted,
  so the root preload sets `NO_PROXY` to `*`. Every child process inherits it, so a child that a
  test sends through a proxy overrides it, as curl's `--noproxy ''` does.
- **MSW sees only `fetch`, and not all of it.** A `fetch` to loopback or a unix socket skips MSW and
  goes to the real network. `node:http` clients and WebSockets bypass MSW too, so those boundaries
  need a real stand-in server.
- **Reuse a stand-in before writing one.** imp has a tested stand-in for nearly every boundary;
  [stand-ins.md](./references/stand-ins.md) sorts them by kind and links each package's folder. To
  boot a real impd, use [`startTestImpd`](../../../packages/daemon/testing/start-test-impd.ts),
  which runs production's startup through `createImpd` on the stubs.
- **A new disk is 32 GiB unless the config says otherwise.** `startTestImpd` sets `defaultDiskBytes`
  to 0, because its storage clones with `copyFile` and a full-size disk makes each checkpoint copy
  or fork take minutes.
- **`createImpd`'s `now` does not reach every clock.** Some services stay on the wall clock;
  [Booting impd](./references/stand-ins.md#booting-impd) lists the gaps and the clocks those
  components take instead.
- **Ports come from [`claimFreePorts`](../../../packages/test-utils/src/claim-free-ports.ts).** It
  claims each port until the test ends, so parallel test processes never share one. A fixed port
  collides.
- **tmpfs lacks disk features.** `tmpdir()` is a tmpfs on some hosts; a test that needs FIEMAP or
  similar makes its directory under `/var/tmp`, never in the checkout.
- **Git hooks leak `GIT_DIR`.** A test that runs git spawns it through the helpers in
  [`git-env.ts`](../../../e2e/lib/git-env.ts), `runGitCommand`, `runGitChecked` or
  `createGitFreeEnv`; otherwise a child git works on this checkout whatever its `-C` says.
- **One impd runs one suite at a time.** A worktree's dev instance needs its own `IMP_DEV_NAME` and
  `IMP_DEV_PORT_OFFSET`. A journey run alone gets no baseline reset and no fixture image build.
- **A journey removes what it makes.** It registers each removal with
  [`registerRemoval`](../../../e2e/lib/register-removal.ts) on the line after the act that made the
  thing, so an imp goes before the template it boots.

## Commands

| Layer                       | Command                                                                            | Needs                                                        |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Unit and package (one file) | `bun test <path>`                                                                  | Bun, bash, git, jq, tar, truncate, mkfs.ext4                 |
| Unit and package (all)      | `bun test`                                                                         | The same, and more memory than a small host has              |
| Dashboard components        | `bun run test:dashboard`                                                           | Bun, bash, tar; a test impd, as the unit row needs           |
| Agent Go                    | `scripts/test-go.sh`                                                               | Go from `agent/go.mod`                                       |
| ksm-exec                    | `cd host/ksm-exec && go test -race ./...`                                          | Linux 6.7 or later with KSM; the exec tests skip elsewhere   |
| Agent Go, root-only tests   | `cd agent && sudo -E env "PATH=$PATH" go test -tags root -race ./...`              | Root, a writable cgroup2                                     |
| Host networking             | `sudo env "PATH=$PATH" IMP_HOST_TESTS=required bun run test:host`                  | Root, `nft`, `iptables`, `ip6tables`, `ip`, `ping`, `sysctl` |
| ACME issuer                 | `bun run test:pebble`                                                              | Docker                                                       |
| Headscale join              | `bun run test:headscale`                                                           | Docker, and the network for the client's packages            |
| Small filesystem            | `IMP_TEST_SMALL_FS=<dir> bun test <file>... -t 'small filesystem'`                 | A 4 GiB loop-mounted XFS at `<dir>`; a tiny tmpfs fails      |
| End to end                  | `e2e/test-e2e.sh [--only <suites> \| --group <1-4>] [--clean \| --reuse] [--keep]` | KVM, Docker; `--help` lists suites and extra needs           |
| One journey                 | `bun test --config=e2e/bunfig.toml ./e2e/suites/<journey>.e2e.ts`                  | A dev instance that is already up                            |
| NixOS module evaluation     | `nix build -L --no-link .#checks.x86_64-linux.eval`                                | Nix with flakes                                              |
| NixOS VMs                   | `nix build -L --no-link .#checks.x86_64-linux.vm`                                  | Nix with `kvm nixos-test` system features                    |
| ZFS on a real pool          | `sudo env "PATH=$PATH" scripts/test-zfs.sh`                                        | Root, the zfs module, `zpool`                                |
| ZFS host with VMs           | `scripts/zfs-host-test.sh`                                                         | sudo, Docker, KVM, the zfs module                            |

CI runs every row but the lone journey, in [`ci.yml`](../../../.github/workflows/ci.yml) and
[`nix.yml`](../../../.github/workflows/nix.yml). When this host lacks what a row needs, push and
read that CI job's result instead of working around it.

## Layers

- Plain `bun test` loads every `*.test.ts` except `packages/dashboard/**`, which only
  `bun run test:dashboard` runs, and the lane files in [Lanes](#lanes).
- A client or MCP server test that needs a real impd lives in
  [`packages/integration/`](../../../packages/integration/), not beside its module.
- Gated tests load in plain `bun test` and skip: the real-pool ZFS tests until `IMP_TEST_ZFS_ROOT`
  and `IMP_TEST_ZFS_DIR` are set, and the small-filesystem tests until `IMP_TEST_SMALL_FS` is.
  `grep -rl IMP_TEST_SMALL_FS packages` lists the files that hold small-filesystem tests, and CI's
  small-filesystem step names each of them.
- Go tests that need root carry the `root` build tag.
- `e2e/lib/*.test.ts` are unit tests of the harness: they run in plain `bun test` with no KVM.

## Lanes

A lane runs the tests that need a real system the unit run cannot host. A lane file's directory or
suffix names that system. [`bunfig.toml`](../../../bunfig.toml) leaves every lane suffix out of
plain `bun test`, even for a file named by its path, so each lane's script replaces that ignore list
and selects its files by suffix. `test:related` leaves lane files out for the same reason.

| Lane              | Files                                   | Real system                                         | Run                                | Per-test ceiling                                      |
| ----------------- | --------------------------------------- | --------------------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| VM end to end     | `e2e/suites/*.e2e.ts`, in the CI groups | KVM Firecracker imps on a dev instance of impd      | `e2e/test-e2e.sh --group <n>`      | 60 s; measured p95 15.7 s, max 99.8 s (`memory.e2e`)  |
| ZFS host with VMs | the suites in `IMP_ZFS_E2E_SUITES`      | KVM imps on a real zpool in a sparse file           | `scripts/zfs-host-test.sh`         | 60 s; measured p95 9.1 s, max 121.8 s (`backups.e2e`) |
| Host networking   | `*.host.test.ts`                        | root, the kernel's netfilter and network namespaces | `bun run test:host`, as root in CI | 15 s                                                  |
| Headscale join    | `*.headscale.test.ts`                   | Headscale and tailscale containers in Docker        | `bun run test:headscale`           | not set yet; measured max 11.0 s (`tailscale-up`)     |
| ACME issuer       | `*.pebble.test.ts`                      | the Pebble ACME server in Docker                    | `bun run test:pebble`              | not set yet                                           |

Nothing enforces the ceilings yet: the e2e harness gives each journey 1 h (`JOURNEY_TIMEOUT_MS` in
[`suites.ts`](../../../e2e/lib/suites.ts)), and `zgeoff/max-test-timeout` checks a lane's ceiling
only from oxlint-config 0.7.0. A host networking test still skips where its namespace probe fails,
and `IMP_HOST_TESTS=required`, which CI sets, turns that skip into a failure. A lane file holds only
the cases that need its real system: a pure case of the same module stays in `<name>.test.ts`.

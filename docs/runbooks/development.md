# Development

How to check a change before you push it, and what CI and the branch rules do with it. The
[install guide](../guides/install.md) sets up the dev instance.

## Checks

```sh
bun run typecheck && bun run lint && bun test
bun run test:dashboard            # the dashboard's component tests, in their own run
bun run test:host                 # nft and iptables in namespaces; IMP_HOST_TESTS=required fails a skip
bun run test:pebble               # the ACME issuer against Pebble in Docker
bun run test:headscale            # tailscale-up.sh joining Headscale in Docker with a tagged key
bun run test:docker               # the CLI's build context against docker buildx
IMP_TEST_SMALL_FS=<dir> bun run test:small-fs   # disk holds and data blocks on a small loop-mounted XFS
bun run format:check && bun run deadcode
bun run lint:shell                # shellcheck and shfmt over install.sh and the shell in scripts/, host/, kernel/, deploy/, e2e/, packages/
actionlint && zizmor --config .github/zizmor.yml .github   # the workflows, as CI lints them
hadolint host/Dockerfile images/base/Dockerfile images/examples/*/Dockerfile
bun run lint:docs                 # every docs link, and every docs/ path code cites, resolves
bun run lint:images               # each example image starts from the pinned base and checks its downloads
bun run lint:workflows            # ci.yml's release job waits on no gate and starts release.yml for its tag
(cd agent && gofmt -l . && go vet ./...)   # gofmt -l lists unformatted files
(cd host/ksm-exec && gofmt -l . && go vet ./... && go test ./...)   # ksm-exec, a Go module of its own
(cd host/oci-fetch && gofmt -l . && go vet ./... && go test ./...)  # oci-fetch, a Go module of its own
(cd host/uffd-handler && gofmt -l . && go vet ./... && go test ./...)  # uffd-handler, a Go module of its own
(cd agent && go tool -modfile=tools/go.mod golangci-lint run --build-tags root ./...)   # the lint CI runs
scripts/test-go.sh                # the agent's Go tests with -race; prints the slowest cases
e2e/test-e2e.sh --clean       # end to end, from a clean state
```

`bun run check` runs the whole-tree gates of CI's `checks` job: dead code, format, the type-aware
lint, doc links, types and every test. It needs more memory than a small host has, so run it on a
large one, or leave it to CI. CI splits `bun test` into two shards on two runners, with two workers
each, and runs each shard in a cgroup capped at 1536 MiB with no swap, through
`scripts/ci/run-memory-capped.sh`, so a shard fails there before it outgrows a 2 GiB imp.
`bun run lint:shell` needs shellcheck 0.11.0 and shfmt 3.14.1 on `PATH`, the versions CI pins; the
shellcheck job in `.github/workflows/ci.yml` pins actionlint, zizmor and hadolint too. Run the
end-to-end harness against a real instance when a change touches the lifecycle, the agent or the
host.

`bun run deadcode` runs knip twice: over the whole tree, then in production mode, which leaves out
every test file. The production run fails on an export that only a test imports. Un-export it when
no test needs it, or tag it `/* @internal */` when a test calls it directly. The tag takes one star,
because the shared lint config bans JSDoc blocks and knip reads a tag from any block comment.

## End-to-end tests

`e2e/test-e2e.sh` brings up the dev instance (`scripts/dev/dev.sh`), then runs each journey file of
each suite in `e2e/suites/` as its own `bun test` process, and resets the suite's leftovers after
each one. Every case drives impd through the `impz` CLI, the way a user would; the dashboard suite
drives it through a browser. The suites run in this order:

| Suite            | What it proves                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle`      | new, exec (stdin, stderr, exit codes, `-t`), console, egress, stop and start, rm                                                                                                                                                                                                                                               |
| `docker`         | Docker in an `images/base` imp: run, build, a published port, egress, a cold boot                                                                                                                                                                                                                                              |
| `images`         | `impz image build`, the image's files, ENV and WORKDIR, image rm                                                                                                                                                                                                                                                               |
| `registry`       | `impz image build` from a TLS registry on a Docker network of its own, which impd opens to builders: a moved tag builds the registry's content by digest; a multi-platform image binds the host's variant; skips unless its name resolves to that network's gateway (`10.200.0.1` at port offset 0) and sudo needs no password |
| `checkpoints`    | checkpoint, restore (running and stopped), forks, labels, deletion                                                                                                                                                                                                                                                             |
| `disks`          | a disk past its image, grown while running, asleep and stopped; fsck after                                                                                                                                                                                                                                                     |
| `sleep`          | idle sleep, wake by HTTP, API and WebSocket, memory kept, the WebSocket relay                                                                                                                                                                                                                                                  |
| `scale`          | many imps under the RAM budget, LRU sleep, wake on request, an oversized imp refused                                                                                                                                                                                                                                           |
| `restart`        | an impd restart re-adopts VMs; stopping the instance sleeps every imp                                                                                                                                                                                                                                                          |
| `tailscale`      | an imp answers tailnet members, a tailnet request wakes it, a rule gives a member the API without a token                                                                                                                                                                                                                      |
| `mcp`            | `impz mcp` over stdio: the guard, odd file paths, modes, a timeout's group kill                                                                                                                                                                                                                                                |
| `mcp-oauth`      | the public MCP route: a sign-in approved with `impz oauth approve`, an MCP client's own OAuth sign-in, tools by scope, refresh replay, a removed token stopping a command, 429                                                                                                                                                 |
| `sessions`       | detach, attach after sleep, takeover, idle and busy sessions, kill                                                                                                                                                                                                                                                             |
| `offsets`        | output offsets: a gap past the ring, exact after a wake, cold-boot causes, `wake: false`                                                                                                                                                                                                                                       |
| `session-logs`   | session logs: 1 MiB kept past the ring, through a sleep and a wake to the exit, read with the imp stopped, kept through a restore, deleted                                                                                                                                                                                     |
| `services`       | `impz service` and `impz logs`: a service the proxy reaches, logs and a follow across a sleep, restarts, a reboot, `--http-port`, remove                                                                                                                                                                                       |
| `ssh`            | `ssh`, `scp`, `sftp`, forwards, a VS Code-style SOCKS forward, the broker env, the firewall                                                                                                                                                                                                                                    |
| `ssh-wake`       | a login wakes a sleeping imp, a refused one does not, a connection keeps it awake                                                                                                                                                                                                                                              |
| `ssh-agent`      | `ssh -A`: `ssh-add -l` and a signed `git push` from the imp, the socket's owner and lifetime, no key in the imp                                                                                                                                                                                                                |
| `reverse`        | `impz proxy --reverse` and `ssh -R`: a socket and a port on this machine from the imp, refusals, sleep and wake, keep-awake                                                                                                                                                                                                    |
| `proxy`          | `impz proxy`: a busy port, a missing imp, both loopbacks, a guest-loopback server, a half-close, an old agent, the tunnel cap                                                                                                                                                                                                  |
| `proxy-wake`     | a proxy connection keeps the imp awake and wakes it; a forced sleep resets it and the next one wakes the imp                                                                                                                                                                                                                   |
| `cp`             | `impz cp` on a non-root image: owner, modes, symlinks, a 48 MiB round trip, a symlink trap, an old agent                                                                                                                                                                                                                       |
| `connectors`     | a secret through the broker: an API call, a git push, tunnels, an oauth secret's refresh, no secret in memory                                                                                                                                                                                                                  |
| `dashboard`      | the web dashboard in headless Chromium: login, create, console, sleep, destroy                                                                                                                                                                                                                                                 |
| `https`          | a wildcard certificate from Pebble, an imp at `https://<name>.<domain>`, a wake                                                                                                                                                                                                                                                |
| `tokens`         | scoped tokens: a read token cannot exec, an exec token for some imps cannot touch another, the audit log, a removed token                                                                                                                                                                                                      |
| `leases`         | two owners on one imp, `LEASED` and a forced sleep, expiry then an idle sleep, a hold; with a budget up to 2048 MiB, a refusal's names                                                                                                                                                                                         |
| `egress`         | open, public, box and none policies: an allow-list, a refused name, the source check, a cut flow, a public imp's refusals                                                                                                                                                                                                      |
| `networks`       | two imps on a network across open and box, names, a peer DNS port, a reset on leave                                                                                                                                                                                                                                            |
| `ipv6`           | a /128 per imp, NAT66 and a routed /64, policies over IPv6, packet-too-big, a guest's router advertisement                                                                                                                                                                                                                     |
| `cpu`            | CPU limits: half a core holds a busy guest, again after a sleep and a wake, `impz set` at once, `impz top`, `docker exec` after the cgroup move                                                                                                                                                                                |
| `templates`      | `impz template`: copies of a running imp's disk, a new machine-id and ssh host keys per copy, kept after a reboot, rm                                                                                                                                                                                                          |
| `boot-templates` | a cold boot restored from a boot template: its own name, MAC, disk size and TCP ISN secret; a sleep and wake after                                                                                                                                                                                                             |
| `inner`          | the inner container: PID 1 inside, signals, `kill -9 -1`, a memory hog, a reboot and the listeners after it, `rm -rf /`, a wiped root                                                                                                                                                                                          |
| `socket`         | no Docker in the dev container: no `docker.sock`, no `/run/imp-docker` and no `docker` binary                                                                                                                                                                                                                                  |
| `podman`         | the builder image that impd fetched by digest, and `impz image build` of a two-line Dockerfile whose file an imp from the image holds; the `podman` CI job runs it under Podman                                                                                                                                                |
| `moves`          | `impz move` to a second instance on a Docker network: cold with a checkpoint, an abort, warm moves of an open and a box imp that keep tmpfs and processes and reach DNS, HTTP and the broker at once                                                                                                                           |
| `moves-tailnet`  | `impz move` between two tailnet nodes: the real peer check on their tailnet addresses                                                                                                                                                                                                                                          |
| `tailnet-names`  | per-imp tailnet names on the test tailnet: an imp's own name, which wakes it, and goes with it on a move; skips unless `IMP_E2E_TAILNET_NAMES=1`                                                                                                                                                                               |
| `chaos`          | kills of impd, Firecracker and the container mid-operation; the watchdog; a full disk                                                                                                                                                                                                                                          |
| `jail`           | the jailer: its own uid, no capabilities, seccomp, a memory cap; sleep, wake and re-adopt jailed; rollback and upgrade between jailed and unjailed                                                                                                                                                                             |
| `memory`         | elastic memory: a guest grows under a gradual allocation, shrinks to its use, and a sleep unplugs spare memory first                                                                                                                                                                                                           |
| `ksm`            | with KSM on the host (CI's runner only): two jailed guests merge the same pages, their Pss falls, the budget holds after they diverge; skips elsewhere                                                                                                                                                                         |
| `backups`        | backups of running and stopped imps and checkpoints, restores, forget and prune                                                                                                                                                                                                                                                |
| `backups-repo`   | an imp left out of backups, a stale lock, a corrupted pack, the database copy                                                                                                                                                                                                                                                  |

```sh
e2e/test-e2e.sh                          # the acceptance set: every suite
e2e/test-e2e.sh --only fast              # the CI subset: every suite in FAST_GROUPS
e2e/test-e2e.sh --only checkpoints,sleep # named suites, run in the order above
e2e/test-e2e.sh --group 2                # one group of the CI subset, as one CI runner runs it
e2e/test-e2e.sh --clean                  # wipe the dev instance's data first
```

| Flag      | Effect                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--only`  | Comma-separated suites or sets. `acceptance` (the default) is every suite; `fast` is the CI subset.                                                         |
| `--group` | One of the groups the `fast` set splits into (`FAST_GROUPS` in `packages/e2e-harness/src/suites.ts`), from `1`.                                             |
| `--clean` | Logs the instance out of the tailnet, removes the container and wipes its data dir, and the moves suites' second host and its data dir.                     |
| `--reuse` | Keeps a running dev instance instead of restarting it with the run's settings. A run with a Headscale suite restarts it anyway, onto the run's new tailnet. |
| `--keep`  | Leaves the run's imps and fixture images in place for a look afterwards.                                                                                    |

The `acceptance` set is the definition of done: the timing limits fail the run, where any other set
only warns about a missed limit. The harness starts Pebble for the https suite, which needs no
domain and reboots the instance with HTTPS on, then off again
([HTTPS](../guides/https.md#testing-with-pebble)). The `fast` set takes about 4.5 minutes, most of
it idle timeouts in the sleep suite and the jail suite's two reboots. The full set adds the suites
outside `FAST_GROUPS`; at its defaults the scale suite alone took about 75 seconds in the last
acceptance run.

The moves suites start a second instance, `<IMP_DEV_NAME>-mv-b`, with its data in
`<IMP_DEV_DATA>-mv-b`, and reboot the run's instance onto a network of their own and back. Each
instance gets a 2 GiB RAM budget there, so a run stays inside one ordinary run's memory. On ZFS the
second instance runs on the root dataset `<IMP_ZFS_ROOT>-mv-b`, so two impds never share one
dataset; `scripts/zfs-host-test.sh` makes it, and a manual run makes it the same way
(`zfs create -o mountpoint=legacy`).

The tailscale, egress and moves-tailnet suites need no secret: the harness starts a Headscale
tailnet of the run's own, and removes it at the end ([the e2e tailnet](./e2e-tailnet.md)). The
tailnet-names suite needs Tailscale itself, so it skips unless `IMP_E2E_TAILNET_NAMES=1`, and then
runs only on its own (`--only tailnet-names`), because one dev instance joins one control server. It
runs on [the test tailnet](./e2e-tailnet.md#the-test-tailnet), with its two OAuth clients in
1Password: the auth-keys client (`IMP_E2E_TAILSCALE_OAUTH_REF`, default
`op://$IMP_OP_VAULT/imp-e2e-test-tailnet-authkeys/client-secret`) and the services client
(`IMP_TAILNET_OAUTH_REF`, default `op://$IMP_OP_VAULT/imp-e2e-tailscale-services`, fields
`client-id` and `client-secret`). Run it with the vault set:

```bash
IMP_OP_VAULT=imp-e2e IMP_E2E_TAILNET_NAMES=1 e2e/test-e2e.sh --only tailnet-names
```

`IMP_DEV_NAME`, `IMP_DEV_PORT_OFFSET` and `IMP_DEV_DATA` pick the dev instance, as for
`scripts/dev/dev.sh`. `IMP_DEV_CONTAINER_CLI=podman` drives the dev container through Podman
([the dev instance's settings](../guides/configuration.md#dev-instance)). The suites that start
containers of their own, such as the registry, Headscale, Pebble and the moves suites' second host,
start them with Docker, so a Podman run takes only the suites that start none. These variables tune
a run:

| Variable                | Default | Effect                                                   |
| ----------------------- | ------- | -------------------------------------------------------- |
| `E2E_RAM_BUDGET_MIB`    | 6144    | impd's RAM budget                                        |
| `E2E_IDLE_TIMEOUT_S`    | 10      | impd's idle timeout                                      |
| `E2E_SCALE_COUNT`       | 30      | imps the scale suite creates                             |
| `E2E_SCALE_MEMORY_MIB`  | 512     | memory of each scale imp                                 |
| `E2E_SCALE_FILL_MIB`    | 256     | tmpfs each scale imp fills                               |
| `E2E_MAX_NEW_MS`        | 3000    | limit for `impz new` plus the first exec                 |
| `E2E_MAX_CHECKPOINT_MS` | 500     | limit for a checkpoint of a running imp, as impd logs it |
| `E2E_CHAOS_ROUNDS`      | 8       | fault rounds of the chaos suite                          |
| `E2E_CHAOS_SEED`        | random  | seed of the chaos suite; the log shows it                |

The scale suite needs the budget plus 2 GiB of free host memory, and free disk on the data volume
for a memory snapshot of each imp (count × memory). It restarts the instance with a 600 s idle
timeout, so the RAM governor, not idleness, decides which imps sleep; the suites after it keep that
timeout. On a smaller machine, lower the budget and the count, for example
`E2E_RAM_BUDGET_MIB=2560 E2E_SCALE_COUNT=12`. The count must pass the number of imps that fit, or
the governor sleeps none and the suite fails at once: an imp restored from a warm boot template owns
about 280 MiB at the default sizes, so 9 fit in 2560 MiB, and a cold-booted one about 320 MiB.

The scale suite holds what the Firecrackers own (`Pss_Anon` + `Pss_Shmem`, read from `smaps_rollup`
without impd) to the budget, and reports their full PSS, which also has clean file pages the
governor does not count
([what the governor measures](../architecture/lifecycle/ram-governor.md#what-it-measures)). A guest
grows past its boot reserve after admission, so use may pass the budget until a governor sleep ends.

The scale suite follows every imp's sleep in the event stream (`ImpChanged slept`, which started
`detail.durationMs` plus `detail.prepareMs` before its time). Use may fall back under the budget for
any reason. It fails when impd's figure or the owned figure goes over by more than a guest can grow
past its reserve, or stays over for one enforce period plus one sample with no enforce sleep
(`detail.trigger` `RAM over budget`) started by then, or is still over after that sleep ends, or
when the sleep takes more than 30 s.

The connectors suite runs a fake github.com on this machine, which the dev container reaches on its
default gateway. A dev instance reads `<IMP_DEV_DATA>/broker-test-upstreams.json` when it exists
(`IMP_BROKER_TEST_UPSTREAMS`):

```json
{ "ca": "-----BEGIN CERTIFICATE-----…", "upstreams": { "github.com": "https://172.17.0.1:9443" } }
```

The broker then sends granted requests for those hosts to the fake, and trusts `ca` next to the
usual roots: verification stays on. The suite writes the file and removes it when it ends.

A run writes `.cache/e2e/results.json`: each suite's verdict and time, and the timings the suites
measure. A suite file also runs on its own against a running instance:
`bun test --config=e2e/bunfig.toml ./e2e/suites/sleep.e2e.ts`.

### Wake bench

`scripts/dev/bench-wake.sh` is a manual check, not part of the harness or CI. It runs
[`impz bench wake-young`](../guides/bench.md) at concurrency 1, which times wakes of an imp put to
sleep right after a cold boot, the case a host kernel before Linux 6.7 makes slow
([young guests](../architecture/lifecycle/sleep-and-wake.md#young-guests)). It fails when the median
wake passes `--limit-ms` (default 500):

```sh
scripts/dev/bench-wake.sh --cycles 3       # IMP_URL and IMP_TOKEN, or the saved login
```

On the WSL2 dev box (host kernel 6.6.87), the median wake was 793 ms with impd's wait off
(`IMP_SLEEP_MIN_GUEST_UPTIME_MS=0`) and 142 ms with the default. On a host kernel with the fix, both
should be fast; the report holds the host's kernel.

## Worktrees

Each checkout of the repo, the main one or a git worktree, runs a dev instance of its own: give it
an `IMP_DEV_NAME` and an `IMP_DEV_PORT_OFFSET`. Its host image is its own too. `scripts/dev/dev.sh`
tags it `imp-host:dev-<dir>-<hash>`, where `<dir>` is the checkout's directory name and `<hash>` the
first 8 hex characters of the sha256 of its path without symlinks. One worktree's build never
replaces the image under another's running instance or e2e run. `IMP_HOST_IMAGE` overrides the tag,
as CI does.

`dev.sh down` keeps the image, so the next `up` starts at once. Once a worktree is gone, its image
stays behind. `scripts/dev/dev.sh prune` removes the images whose checkout directory is gone and
that no container uses, and the untagged images that rebuilds leave. It finds them by two labels:
the checkout's path (`imp.worktree`) and the machine's `/etc/machine-id` (`imp.machine`), because
Docker Desktop shares one daemon across WSL distros and devcontainers. Without a machine id, a build
gets no `imp.machine` label, so no prune ever removes it, and prune itself stops with an error. It
removes only the checkout's own tag, keeps every live checkout's image, and never touches an image
without the labels. An image built under an `IMP_HOST_IMAGE` override keeps that tag, so prune
leaves it; remove it by hand, as you would an `imp-host:<worktree>-dev` tag from the old workaround.
An `imp-host:dev` image from before the per-checkout tags has no label, so remove it by hand too:
`docker image rm imp-host:dev`.

## Daemon tests

The daemon's tests need no VM. `startTestImpd` in `packages/daemon/testing/` starts impd through the
same startup as production, over an in-memory database and a stub VMM
(`testing/vm/build-stub-vmm.ts`). A test scripts what the next boot, wake, sleep, stop or agent
check does (succeed, fail, die or hang), holds a step until it releases it, and restarts impd over
the same database and VMs. Another package's tests import the harness from `@impz/daemon/testing`.
`readBrokenInvariants` reads the raw records, because a read through the service repairs what it
finds.

After you add a migration, run `bun run render:db-schema`: kysely-codegen writes the daemon's typed
schema from a freshly migrated database, and `bun test` fails while the committed file differs.

After you change the agent protocol's schema, `proto/imp/agent/v1/agent.proto`, run
`bun run gen:proto`. It lints the schema with buf, then writes the agent's Go types (with
`protoc-gen-go` from the agent's `go.mod`, so Go must be on `PATH`), impd's TypeScript types and
`docs/reference/agent-protocol.md`. CI runs it again and fails while the committed output differs. A
further CI step compares the schema with main's under buf's `WIRE_JSON` rules and fails a change
that breaks the wire format, binary or JSON, such as a changed field number or JSON name. Run the
same check before you push with `bun x buf breaking --against '.git#branch=main'`.

The property tests use fast-check. On a failure it prints the seed and the path of the shrunk case.
Pass both to `fc.assert` as `{ seed, path, endOnFailure: true }` to replay the case.

## Dashboard tests

The [dashboard guide](../guides/dashboard.md#tests) covers its component tests and its Playwright
run.

## Git hooks

Lefthook installs the hooks with `bun install`.

- **pre-commit** fixes the staged files (oxlint, oxfmt, format-codemod, and shfmt on staged `.sh`
  files), then runs gitleaks on them. gitleaks and shfmt must be on `PATH`.
- **commit-msg** runs commitlint: conventional commits, lowercase, a header of 72 characters or
  fewer.
- **pre-push** runs one job at a time: `lint:docs`, `lint:images`, `lint:workflows` and shellcheck,
  then the shared baseline in `.lefthook/pre-push-baseline.yml`, which repo-sync delivers from
  zgeoff/tools. The baseline checks the format and the types of the whole tree, and lints and tests
  only the files the branch changes since its merge base with `origin/main`. A dashboard file's
  tests run from its package. CI's `checks` job runs type-aware lint, deadcode and every test. On a
  branch that changes the agent's, ksm-exec's, oci-fetch's or uffd-handler's Go, pre-push also runs
  `gofmt` on the changed files and `go vet -p 1`, which keeps vet's memory within what a 2 GB imp
  can spare; the Go lint, vulnerability and dead-code gates run in CI only.

## CI

`.github/workflows/ci.yml` runs these jobs on every push to `main` and every pull request:

| Job          | Required | What it runs                                                                                                                                                                                                                                                     |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitleaks`   | yes      | A secret scan over the history.                                                                                                                                                                                                                                  |
| `checks`     | yes      | Passes only when the `checks-unit` and `checks-lanes` jobs passed: `bun test` in two shards of two workers, capped at 1536 MiB with no swap, and `bun run audit`, the Bun pin check, `bun run check:static`, the lane tests and the dashboard's tests and build. |
| `go`         | yes      | In `agent/`, `host/ksm-exec`, `host/oci-fetch` and `host/uffd-handler`: `gofmt`, `go vet`, golangci-lint, govulncheck, deadcode, the tests; the agent's again as root with the `root` tag. Also `gofmt`, vet and lint on the Dockerfile difftest module.         |
| `shellcheck` | yes      | `bun run lint:shell`, actionlint and zizmor over `.github/`, hadolint over both Dockerfiles, and the tests that shellcheck the shell production code holds as text.                                                                                              |
| `cli`        | yes      | Compiles the CLI for every platform and runs the linux-x64 one; builds the release image's compile stage.                                                                                                                                                        |
| `client`     | yes      | Packs `@impz/client`, installs it on the oldest Node it supports, and smokes it under Node, Bun and a compiled Bun binary.                                                                                                                                       |
| `e2e`        | yes      | Passes only when every `e2e-group` job passed: the `fast` end-to-end set on real microVMs, in four groups on four runners (below).                                                                                                                               |
| `zfs`        | yes      | Passes only when every `zfs-shard` job passed: real imps on a ZFS pool in three shards, and `scripts/test-zfs.sh` in one (below).                                                                                                                                |
| `podman`     | no       | `e2e/podman/run-podman-proof.sh`: the proof that an imp host runs with no Docker engine (below).                                                                                                                                                                 |

The `checks` job also runs the docs-writing skill's scripts. `bun run lint:docs` runs
`check-links.sh`, which fails on a broken relative link or anchor in a README or a page under
`docs/`. It then runs `scripts/ci/check-doc-citations.ts`, which fails on a `docs/` path or anchor
cited outside Markdown that does not resolve, such as a code comment that names a page a docs
rewrite moved. `check-length.sh` reports README and docs/ lengths and runs `check-prose.sh`, without
failing the job.

`bun run audit` ignores one advisory by its ID. GHSA-86w9-cpqp-85rv is a flaw in node-forge's RSA
signature verification, and no fixed node-forge exists (all versions up to 1.4.0). acme-client loads
node-forge, but impd uses only `acme.crypto`, which runs on Node's own crypto and never calls
node-forge to verify a signature. Drop the ignore when a fixed node-forge or an acme-client without
it ships.

`package.json` pins `source-map-js` to 1.2.2 through `overrides`, so every copy in the tree resolves
to it. Version 1.2.2 fixes GHSA-68fv-2mgg-jv7q, which reaches the dashboard through vite and
postcss.

On `main`, the `release` job makes releases ([releasing](./releasing.md)).

### The e2e job

The `fast` set runs in four groups (`FAST_GROUPS` in `packages/e2e-harness/src/suites.ts`), one
`e2e-group` job per group, each on its own runner. The `e2e` job is the required check: it fails
when any group failed, was cancelled or was skipped. Each group boots real Firecracker guests on a
standard `ubuntu-24.04` runner (4 cores, 16 GB), which exposes `/dev/kvm`. `scripts/ci/check-kvm.sh`
runs first, so a runner without KVM fails in seconds with the reason. The job then:

1. builds the guest kernel and the system drive from the `system-files` stage, with the release's
   GitHub Actions cache (scope `system-files`): the kernel rebuilds only when `kernel/build.sh`,
   `kernel/version` or the kernel config files change, or after GitHub evicts the cache (7 days
   unused, or the repo's 10 GB quota). A cold kernel build takes about 10 minutes, so the job's
   timeout is 25.
2. builds the dev host image as `imp-host:dev` with a cache of its own (scope `imp-dev`). The `e2e`
   and `zfs` jobs in `ci.yml` set `IMP_HOST_IMAGE=imp-host:dev` and `IMP_HOST_IMAGE_READY=1`, so
   `scripts/dev/dev.sh` uses that image instead of building it again. Only group 1's run on `main`
   writes these caches, so four writers never race; pull requests only read them. Steps 1 and 2 are
   the composite action `.github/actions/e2e-build`, which the `zfs` job uses too.
3. restores the Playwright browser cache (`~/.cache/ms-playwright`), keyed on the Playwright version
   in `bun.lock`, which pins the Chromium build, in the group with the dashboard suite only. The
   dashboard suite installs that Chromium's headless shell when the cache misses.
4. runs `e2e/test-e2e.sh --group N` with `E2E_RAM_BUDGET_MIB=4096`, `IMP_DEFAULT_MEMORY_MIB=1024`
   and the XFS file on the runner's `/mnt` disk. No workflow holds a Tailscale secret: group 4's
   tailnet suites join the Headscale tailnet that the harness starts, and a missed timing limit only
   warns. The host networking tests run in group 2 only (`HOST_TESTS_GROUP`).

The ZFS suites run in three `zfs-shard` jobs, each on its own runner, and the `zfs` job is the
required check over them, as `e2e` is over the groups. Each shard builds the same inputs, reading
the caches only, caps the ZFS ARC at 1 GiB, and runs the suites in its matrix row on a pool in a
sparse file through `scripts/zfs-host-test.sh`. The backups suites and the moves suite run in these
shards alone, so real VMs move between two ZFS hosts there. One shard also runs
`scripts/test-zfs.sh`. Each shard's job summary shows its ZFS timings, and its `zfs-e2e-results-N`
artifact holds the logs and `results.json`, where each backup test reports the split of its time.

After a pass, a failure or a timeout, each group saves an `e2e-results-N` artifact (14 days):
`results.json`, `metrics.jsonl`, `impd.log` (the dev container's whole log) and the dashboard
suite's Playwright traces and screenshots. A failed suite also prints the last 40 lines of impd's
log inline. Download one with `gh run download <run-id> -n e2e-results-1`.

The `e2e` job is a required check, and the release job merges a release PR only after it passes. It
became one after it passed on every push to `main` from its first run (#2).

If GitHub-hosted runners lose KVM, move the job to an ephemeral, dedicated self-hosted runner and
run it only on push to `main`, never on pull requests. Never use the deploy box. The repo is public,
so a pull request from a fork would get a privileged container with `/dev/kvm` on that runner.

A new push to a pull request cancels its older run. On `main`, a run that has started finishes, but
a run still waiting behind it is cancelled when a newer push comes, so only the newest push runs
next.

`.github/workflows/bootstrap.yml` runs `e2e/test-bootstrap.sh --stub --zfs` when a pull request or a
push to `main` changes `deploy/` or the test ([Bootstrap a server](../guides/install.md#test-it)).
Its job is a required check.

`deploy/bootstrap.sh` is generated, so that a server downloads one file to install. Its sources are
the parts in `deploy/bootstrap/`, the functions in `deploy/lib/host-env.sh` that `deploy/upgrade.sh`
and the NixOS module source as well, and the units and env template it installs.
`deploy/imp-host.args.json` holds the `podman run` arguments of imp-host, with the name and bridge
of the IPv6 network and the pipeline that reads the host's addresses. After an edit to any of these,
`bun run render:deploy` writes the unit, the network lines of `deploy/lib/host-env.sh` and
`bootstrap.sh`. `bun test` fails until it has (`scripts/render/render-imp-host.test.ts`), and so
does a hand edit to `bootstrap.sh`. The NixOS module reads the arguments file itself.

`.github/workflows/breaking-change.yml` fails a pull request that breaks the protocol between a
client and impd without marking the change as breaking
([Breaking changes](./releasing.md#breaking-changes)). It runs again when the PR's title or body
changes, and its job is a required check.

`.github/workflows/nix.yml` checks the format of the `.nix` files and runs `nix flake check` when
`flake.nix`, `flake.lock`, `deploy/` or `tailscale-up.sh` change: the NixOS module's eval check, and
a NixOS VM test that needs KVM ([NixOS](../guides/nixos.md#test-it)). Both jobs are required checks.

A required check must report on every pull request, because GitHub blocks the merge while a required
check waits for a status. The nix and bootstrap workflows therefore run on every pull request, and a
first job compares the files the pull request changes against the workflow's path list. When none
match, the work jobs skip, and GitHub reports a job skipped by its condition as a success. A push to
`main` keeps its own path filter.

`.github/workflows/e2e-images.yml` runs the images suite, which sits outside `FAST_GROUPS`, on a KVM
runner with the e2e groups' sizes and caches. It runs each day on `main`, and on a pull request that
changes the image code its path list names. Its job is no required check. Run it on a branch by
hand, then download its `e2e-images-results` artifact:

```bash
gh workflow run e2e-images.yml --ref <branch>
```

`.github/workflows/reproducible.yml` runs `scripts/release/check-reproducible.sh` (the guest kernel
and the system drive rebuild to the same bytes). It takes two cold kernel builds, so it runs by
hand: `gh workflow run reproducible.yml`.

### The bench job

`.github/workflows/bench.yml` runs [`impz bench`](../guides/bench.md) on a KVM runner with the e2e
groups' caches. It is no required check, and no pull request runs it, because a compare outlasts the
release job's wait on a pull request's checks. A push to a `bench/**` branch, or a dispatch,
compares a baseline with its own ref:

1. The job checks out the baseline (default `main`) beside the ref, and builds each one's kernel and
   system drive, so each side boots its own guest agent.
2. `scripts/bench/run-bench-arms.ts` brings up a dev instance from each checkout in turn, over one
   data dir. Each side first creates 3 imps that the bench does not time, so its boot template is
   ready before the timed run starts.
3. Each side runs once per round, in turn, so a slow stretch of the runner falls on both. The job
   summary holds a table of each side's median p50, p95 and p99 over its rounds, and the change
   against the baseline. The `bench-results` artifact holds each run's JSON report and impd's log.

To compare a change, push it to a branch under `bench/`, then delete the branch once you have the
table:

```bash
git push origin HEAD:bench/<change>
gh run list --workflow bench.yml --branch bench/<change>
git push origin --delete bench/<change>
```

A `bench/**` branch whose name holds `huge-pages` reserves a 2 MiB pool and runs impd with
`IMP_HUGE_PAGES=2M`. It also runs `scripts/bench/measure-touched-pages.ts` first, which writes into
a guest's memory, puts it to sleep, wakes it, reads the same memory back and puts it to sleep again.
It prints the pool pages the guest held at each sleep, which a 2 MiB sleep's diff writes in full,
beside the 4 KiB pages whose bytes changed, which a dirty-page diff writes
([huge pages](../architecture/lifecycle/huge-pages.md#sleep)).

### The podman job

The `podman` job proves that an imp host runs with no Docker engine. It builds the e2e groups'
inputs on a KVM runner, reading the caches only, and runs `e2e/podman/run-podman-proof.sh` as root.
The script fails at the first check that does not hold, with the reason, and at the end prints every
check it made:

1. It starts the dev instance under Docker, waits for impd to add its builder image and its default
   image, makes the imp `e2e-podman-keep` with a file in it, and records the builder image's id and
   digest.
2. It stops the instance, loads the host image into Podman (`docker save | podman load`), masks
   `docker.socket` and `docker.service`, and checks that `/var/run/docker.sock` is gone and that
   `docker info` reaches no engine.
3. It starts the instance under Podman on the same data dir, and checks that the container has no
   Docker socket and no `docker` binary, that it runs with no pids limit, that it can make device
   nodes where an image unpack writes them, that impd lists `e2e-podman-keep` with its file intact,
   and that the builder image keeps its id and digest, so impd did not fetch it again.
4. It starts a second instance under Podman on a fresh data dir, `<data>-fresh`, and waits for impd
   to fetch its builder image there, with Docker masked.
5. It runs `e2e/test-e2e.sh --only socket,podman` on that instance.

The script masks Docker for good, so it refuses to run unless `CI=true`. The job uploads an
`e2e-results-podman` artifact with impd's log under Docker (`impd-docker.log`) and under Podman
(`impd.log`). It is no required check, and the `e2e` job does not wait for it.

## Branch rules

`.github/rulesets/main.json` protects `main`: every job it lists as a required status check must
pass, changes arrive through a squash-merged pull request, and the branch cannot be deleted or
force-pushed. A repository admin can bypass it only to merge a pull request, never to push to
`main`. The ruleset is applied on GitHub as `main protection`.

# Agent Guidelines

imp gives you small Linux computers. Each one is a Firecracker microVM with real root, its own
kernel and Docker inside. It sleeps when it is idle, and the next request wakes it with its disk and
memory as they were. [`docs/architecture/overview.md`](docs/architecture/overview.md) explains how
the pieces fit, and [`docs/runbooks/development.md`](docs/runbooks/development.md) holds the checks,
the end-to-end harness, worktree dev instances, the hooks, and CI.

## Required reading

The rules a task needs are not repeated here. Load the skill for the work before starting it.

| Skill                | Load before                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| `code-style`         | writing, reviewing, or renaming any TypeScript — the shared function-naming rules    |
| `project-code-style` | the same, beside `code-style` — imp's domain verbs, and method names a library sets  |
| `testing`            | designing, writing, or reviewing tests                                               |
| `project-testing`    | the same, beside `testing` — imp's test commands, lanes and test utils               |
| `ci-design`          | adding or changing a workflow, a job or a step                                       |
| `project-ci-design`  | the same, beside `ci-design` — imp's test budget, required checks and workflows      |
| `docs-writing`       | writing or editing any committed prose: [`docs/`](docs/), READMEs, this file, skills |
| `skill-writing`      | writing or editing a skill                                                           |
| `cold-read`          | checking a skill you wrote or changed, before its PR                                 |
| `deslop`             | editing the prose of a skill you wrote or changed, before its PR                     |

When you write or edit a skill:

1. Load the `skill-writing`, `cold-read` and `deslop` skills from `.claude/skills/`. Install none of
   them yourself: repo-sync, the job that copies shared files into this repo, delivers them there.
2. Do every step in the "Check it" section of `.claude/skills/skill-writing/SKILL.md`.
3. In the PR description, after the sections of the repo's PR template, add three `##` headings:
   - "Skill checks": the check output.
   - "Cold read": each cold-read finding, and how you answered it.
   - "Deslop": each change deslop made, or "none".

## Repo structure

imp is one Bun workspace for its TypeScript, plus a Go module for the guest agent and one each for
the host's ksm-exec, oci-fetch and uffd-handler. Every package takes the name `@impz/<folder>`, and
one package imports another as TypeScript source, with no build step.

```text
agent/             the guest agent, in Go: imp-agent under cmd/
packages/
  agent-protocol/  impd's side of the guest agent's vsock protocol: frames, messages, error codes
  api/             the oRPC contract, schemas and exec stream framing of the control API
  cli/             impz, the command-line client
  client/          the typed client for impd
  daemon/          impd, the host daemon; e2e/ holds its end-to-end suites and their fixtures,
                   and bench/ the scripts that the bench workflow, bench.yml, runs
  dashboard/       the web dashboard that impd serves at /ui/
  durable/         the durable work library for any program on SQLite: an event log, operations
                   that resume or undo their steps after a restart, and reconcilers
  e2e-harness/     the end-to-end and bootstrap harnesses that scripts/test-e2e.sh and
                   scripts/test-bootstrap.sh run, and the helpers the suites import
  local-tar/       local files as a tar, for impz cp and image build contexts
  mcp/             the MCP server: imps, exec, files and checkpoints as tools
  shared/          pure helpers that know nothing about imp, and in src/test-utils/ the test
                   preload and the utils every package's tests share
  testing/         @impz/testing: impd on the daemon's stand-ins (test versions of its host
                   boundaries), published for other repos' tests
proto/             the agent protocol; bun run gen:proto generates the Go, TypeScript and
                   docs/reference/agent-protocol.md from it
host/              the host container image that runs impd; ksm-exec, the Go program that
                   starts Firecracker with its memory mergeable; oci-fetch, the Go program
                   that reads the builder image from its registry; and uffd-handler, the Go
                   program that serves a guest's pages on a restore onto huge pages
images/            the guest images that ship with imp
kernel/            the guest kernel build
deploy/            the systemd units, bootstrap and the NixOS module
scripts/           the ci, dev, release and render scripts
patches/           bun patches for third-party packages
docs/
  architecture/    how imp is built
  guides/          steps a user does
  reference/       generated reference
  runbooks/        operator and contributor procedures
```

## Consumers

imp is a standalone sandbox host, so its docs, code and tests name no product that uses it. A rule
that only one consumer's deployment needs, such as the order in which that consumer and impd
upgrade, belongs in the consumer's own repo. Here, state the general rule, and give an example
consumer an invented name.

## Packages

- Every external version lives once, in the root `workspaces.catalog`. A package writes `"catalog:"`
  for an external dependency and `"workspace:*"` for an internal one.
- Pin exact versions, with no `^` or `~` ranges. `bun add` already saves exact versions, through the
  `exact` setting in [`bunfig.toml`](bunfig.toml); the rule is for hand-written edits.
- The `zgeoff/import-zones` options in [`.oxlintrc.json`](.oxlintrc.json) hold the package
  boundaries. When an import breaks one, read that entry's reason for the fix.
- Import a package by its name and an entry that its `package.json` exports, from any code in the
  repo, tests, scripts and e2e suites too. `no-restricted-imports` fails a path into another
  package.
- Put a test helper that another package needs in the `src/test-utils/` of the package whose code it
  starts, builds or fakes. Import it through that package's `./test-utils` export, such as
  `@impz/daemon/test-utils`. Put a helper that knows nothing about imp in
  `packages/shared/src/test-utils/`.
- impd's code in `packages/daemon/src/` sits in one folder per layer, and the `daemon-layer-*`
  entries of `zgeoff/import-zones` give the order: a layer imports only itself and the layers below
  it. The files at the top of `src/`, such as `create-impd.ts` and `main.ts`, are the composition
  root: they build impd from the layers, so they sit above every layer.
- The vm layer's folders, in `packages/daemon/src/vm/`, follow the same rule among themselves: the
  `daemon-vm-folder-*` entries give their order, so no import cycle runs between two vm folders. A
  new vm folder takes a place in that order.
- The broker's folders in `packages/daemon/src/network/broker/` follow the same rule: the
  `daemon-broker-folder-*` entries give their order, and `broker-service.ts` sits above them all.
- The agent's packages in `agent/internal/` sit in one folder per layer, and the `layer-*` depguard
  rules in [`agent/.golangci.yml`](agent/.golangci.yml) give the order and deny each upward import.
  A new package goes in its layer's folder and takes that layer's rule. Two packages sit outside the
  folders: `proto`, whose path the generated Go code sets, belongs to the bottom layer, and
  `contract` holds the golden tests whose fixtures impd's tests read by path, so moving those
  fixtures breaks impd's tests.

## Commands

[`docs/runbooks/development.md`](docs/runbooks/development.md) lists every check. These are the ones
with a catch:

- `bun test` skips the dashboard, whose component tests need a DOM. Run them with
  `bun run test:dashboard`.
- `bun run lint` is plain oxlint. `bun run lint:full` adds the type-aware pass and the type check.
  oxlint runs both through tsrslint (`@maschwenk/tsrslint`), a Rust port of tsgolint, in tsgolint's
  place, because stock tsgolint runs out of memory on this repo on a 2 GiB host. `lint:full` is
  CI-only: never run it locally.
- lefthook runs the checks in [`lefthook.yml`](lefthook.yml) before a commit and a push. On a 2 GiB
  host, leave the other checks to CI. `bun run check` runs every check and needs more memory than a
  2 GiB host has.
- For the Go agent, run `gofmt -l .` and `go vet ./...` in [`agent/`](agent/). golangci-lint,
  govulncheck and the race tests in [`scripts/test-go.sh`](scripts/test-go.sh) each need more than 2
  GiB, so leave them to CI on a 2 GiB host.
- For the Nix flake in [`flake.nix`](flake.nix), `nix fmt -- --check` checks the `.nix` files and
  `nix flake check` runs the NixOS module's checks. The VM check needs KVM.
- Each checkout runs a dev instance of its own through [`scripts/dev/dev.sh`](scripts/dev/dev.sh),
  so give a worktree its own `IMP_DEV_NAME` and `IMP_DEV_PORT_OFFSET`. After you remove a worktree,
  `dev.sh prune` removes its host container image.

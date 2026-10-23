# Agent Guidelines

imp gives you small Linux computers that stay yours: each one is a Firecracker microVM with real
root, its own kernel and Docker inside.
[`docs/architecture/overview.md`](docs/architecture/overview.md) explains how the pieces fit, and
[`docs/runbooks/development.md`](docs/runbooks/development.md) holds the checks, the end-to-end
harness, worktree dev instances, the hooks, and CI.

## Required reading

The rules a task needs are not repeated here. Load the skill for the work before starting it.

| Skill                | Load before                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| `code-style`         | writing, reviewing, or renaming any TypeScript — the shared function-naming rules    |
| `project-code-style` | the same, beside `code-style` — imp's domain verbs and the names a library fixes     |
| `testing`            | designing, writing, or reviewing tests                                               |
| `project-testing`    | the same, beside `testing` — imp's own test facts                                    |
| `docs-writing`       | writing or editing any committed prose: [`docs/`](docs/), READMEs, this file, skills |

## Repo structure

imp is one Bun workspace for its TypeScript, plus a Go module for the guest agent and one for the
host's ksm-exec. Every package takes the name `@impz/<folder>`, and another package imports a
library as TypeScript source, with no build step.

```text
agent/             the guest agent, in Go: imp-agent under cmd/
packages/
  agent-protocol/  impd's side of the guest agent's vsock protocol: frames, messages, error codes
  api/             the oRPC contract, schemas and exec stream framing of the control API
  cli/             impz, the command-line client
  client/          the typed client for impd
  daemon/          impd, the host daemon
  dashboard/       the web dashboard that impd serves at /ui/
  integration/     the client's and the MCP server's tests against a real impd, which sit
                   downstream of the daemon because the daemon depends on both packages
  local-tar/       local files as a tar, for impz cp and image build contexts
  mcp/             the MCP server: imps, exec, files and checkpoints as tools
  shared/          pure helpers that know nothing about imp
  test-utils/      the test preload and the utils every package's tests share
proto/             the agent protocol; bun run gen:proto generates the Go, TypeScript and
                   docs/reference/agent-protocol.md from it
host/              the host container image that runs impd, and ksm-exec, the Go program that
                   starts Firecracker with its memory mergeable
images/            the guest images that ship with imp
kernel/            the guest kernel build
deploy/            the Compose recipe, the systemd units, bootstrap and the NixOS module
e2e/               the end-to-end harness and its suites
scripts/           the ci, dev, release and render scripts
patches/           bun patches for third-party packages
docs/
  architecture/    how imp is built
  guides/          steps a user does
  reference/       generated reference
  runbooks/        operator and contributor procedures
```

## Packages

- Every external version lives once, in the root `workspaces.catalog`. A package writes `"catalog:"`
  for an external dependency and `"workspace:*"` for an internal one.
- Pin exact versions, with no `^` or `~` ranges. `bun add` saves exact versions through the `exact`
  setting in [`bunfig.toml`](bunfig.toml), so the rule covers hand-written edits.
- The `zgeoff/import-zones` options in [`.oxlintrc.json`](.oxlintrc.json) hold the package
  boundaries, and each entry's reason holds the fix.
- Code anywhere in the repo, tests, scripts and e2e suites included, imports a package by its name
  and an entry that its `package.json` exports. `no-restricted-imports` fails a path into another
  package. A test helper that another package needs goes out through that package's test entry, such
  as `@impz/daemon/testing`.
- impd's code in `packages/daemon/src/` sits in one folder per layer, and the `daemon-layer-*`
  entries of `zgeoff/import-zones` give the order: a layer imports only itself and the layers below
  it. The composition root's files sit at the top of `src/`, above every layer. A known upward
  import carries a disable comment that holds the issue that removes it.
- The vm layer's folders follow the same rule among themselves: the `daemon-vm-folder-*` entries
  give their order, so no import cycle runs between two vm folders. A new vm folder takes a place in
  that order.
- The agent's packages in `agent/internal/` sit in one folder per layer, and the `layer-*` depguard
  rules in [`agent/.golangci.yml`](agent/.golangci.yml) give the order and deny each upward import.
  A new package goes in its layer's folder and takes that layer's rule. Two packages sit outside the
  folders: `proto`, whose path the generated Go code fixes, belongs to the bottom layer, and
  `contract` holds the golden tests whose fixtures impd's tests read by path.

## Commands

[`docs/runbooks/development.md`](docs/runbooks/development.md) lists every check. These are the ones
with a catch:

- `bun test` skips the dashboard, whose component tests need a DOM. Run them with
  `bun run test:dashboard`.
- `bun run lint` is plain oxlint. `bun run lint:full` adds the type-aware pass and the type check,
  and is CI-only: never run it locally.
- lefthook runs the light checks before a commit and a push. Leave the heavier checks to CI, because
  the host may have little memory. `bun run check` runs all of them and needs a large host.
- For the Go agent, run `gofmt -l .` and `go vet ./...` in [`agent/`](agent/). golangci-lint,
  govulncheck and the race tests in [`scripts/test-go.sh`](scripts/test-go.sh) each need more than 2
  GB, so leave them to CI on a small host.
- For the Nix flake in [`flake.nix`](flake.nix), `nix fmt -- --check` checks the `.nix` files and
  `nix flake check` runs the NixOS module's checks. The VM check needs KVM.
- Each checkout runs a dev instance of its own through [`scripts/dev/dev.sh`](scripts/dev/dev.sh),
  so give a worktree its own `IMP_DEV_NAME` and `IMP_DEV_PORT_OFFSET`. After you remove a worktree,
  `dev.sh prune` removes its host image.

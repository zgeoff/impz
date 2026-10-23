---
name: project-code-style
description:
  imp's additions to the shared code-style skill — the meaning of imp's own domain verbs, and where
  the names a library fixes are exempt. Load it beside code-style before writing, reviewing, or
  renaming any TypeScript in this repo.
---

# imp code style

The `code-style` skill holds the rules, and its role table decides the verb for every job it lists.
imp names its other jobs with the domain verbs below. Each is a free verb under the shared skill,
and imp keeps it to one meaning, so a name that starts with one tells the reader the job without a
trip to the function.

## Domain verbs

imp's verbs name the lifecycle an imp moves through, its disk, which only grows, and its elastic
memory, which also shrinks.

- `allocate` reserves a slot, an address, or another numbered resource from a pool.
- `list` returns every record of a kind that the caller may see.
- `sleep`, `wake` and `hold` move an imp through its lifecycle: `hold` keeps it awake while work
  runs.
- `grow` enlarges a disk or an elastic imp's memory, and `shrink` returns memory to the host.
- `watch` follows impd's event stream and calls back on each change until a signal ends it, opening
  the stream again when it drops.
- `dispatch` runs the handler that the first word of a command line names, for a command whose verbs
  share its arguments.
- `wire` builds a service from its real dependencies, where the matching `create` function takes
  them as arguments, so a test calls `create` with stand-ins.

## Names a library fixes

A method whose name a library interface fixes, such as the MCP SDK's `saveTokens`, keeps that name.
Each such name sits in the `exemptNames` option of `zgeoff/function-verb` in
[`.oxlintrc.json`](../../../.oxlintrc.json), with a comment that names the interface. The fixed name
wins over the shared rule that `make`, `with`, `use`, `on` and `to` take a suffix, so a stand-in for
Node's stdin keeps its bare `on` method.

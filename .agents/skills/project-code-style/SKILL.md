---
name: project-code-style
description:
  "imp's domain verbs, each with its one meaning and an example from the code, and the rule for a
  method name that a library interface sets. Load it beside code-style before you write, review or
  rename TypeScript in this repo."
metadata:
  kind: rule-set
---

# imp code style

## Departures

- Keep a method name that a library interface sets, such as `saveTokens`. The Function naming
  section of [code-style](../code-style/SKILL.md) asks for another verb or a suffix, but the library
  calls the method by that name.
- Keep the name `on` in a stand-in for Node's process or stdin, because the code under test calls
  the EventEmitter method `on`.

## The function-verb lint rule

- List each name that a library interface sets in the `exemptNames` option of `zgeoff/function-verb`
  in [`.oxlintrc.json`](../../../.oxlintrc.json), with a comment above it that names the interface.

## Domain verbs

Use these verbs for jobs that code-style's verb table has no verb for. Keep each verb to the one
meaning in the table.

| Verb                    | Use it for a function that                                                         | Example                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allocate`              | reserves a numbered resource from a pool, such as a slot or an address             | [`allocateSlot`](../../../packages/daemon/src/platform/db/allocate-slot.ts)                                                                                                 |
| `list`                  | returns every record of one kind, filtered to the records the caller has access to | [`listImps`](../../../packages/daemon/src/platform/db/imps.ts)                                                                                                              |
| `sleep`, `wake`, `hold` | moves an imp to sleep, wakes it, or keeps it awake while work runs                 | [`sleepImp`](../../../packages/daemon/src/imps/imps/imp-commands.ts), [`wakeImp`](../../../packages/daemon/src/imps/imps/imp-commands.ts)                                   |
| `grow`                  | enlarges a disk, a filesystem or a guest's memory                                  | [`growDiskFile`](../../../packages/daemon/src/imps/imps/imp-disk.ts), [`growFilesystem`](../../../packages/daemon/src/imps/imps/imp-disk.ts)                                |
| `shrink`                | gives a guest's memory back to the host; a disk never shrinks                      | [`shrinkGuest`](../../../packages/daemon/src/vm/memory/shrink-guest.ts)                                                                                                     |
| `watch`                 | reads impd's event stream, calls back on each event, and reconnects after a drop   | [`watchEvents`](../../../packages/client/src/events/watch-events.ts)                                                                                                        |
| `dispatch`              | picks a CLI subcommand's handler from the first operand and runs it                | [`dispatchVerb`](../../../packages/cli/src/cli/dispatch-verb.ts)                                                                                                            |
| `wire`                  | builds a service from its real dependencies and passes them to its `create…`       | [`wireHttpsService`](../../../packages/daemon/src/network/https/wire-https-service.ts), [`createHttpsService`](../../../packages/daemon/src/network/https/https-service.ts) |

- Give a `watch` function an `AbortSignal` that ends it.
- Put a service's logic in its `create…` function, which takes each dependency as an argument, so a
  test calls `create…` with stand-ins. Keep the `wire…` function to construction only.

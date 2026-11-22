# Events, audit and telemetry

impd reports what happens to imps in a live event stream, in an audit log of the calls that changed
something, and in OpenTelemetry metrics and spans for a collector you run. Follow the stream with
`impz events` or the SDK. Read the audit log with `impz audit`, and point impd at a collector with
`OTEL_EXPORTER_OTLP_ENDPOINT`.

## The event stream

`events.stream` on `/rpc` sends every imp as it is, then each change as it happens. The CLI prints
it as one JSON object a line:

```sh
impz events            # every imp
impz events box        # one imp
impz events | jq -c 'select(.ev == "ImpChanged") | {name: .imp.name, reason, ms: .detail.durationMs}'
```

The SDK returns an async iterator:

```ts
const events = await client.events.stream();

for await (const event of events) {
  console.log(event.ev, event.at);
}
```

The dashboard follows the same stream ([dashboard](./dashboard.md)).

### Resume from a cursor

To pick up where a reader stopped, pass the `seq` and `logId` of its cursor. Set the cursor by the
rules at the end of this section:

```ts
const events = await client.events.stream({ after: last.seq, logId: last.logId });
```

impd then sends every event after that `seq`, across its own restarts, and goes on live, with no
snapshot. When impd no longer holds those events, it sends `Reset` and then the snapshot. That
happens when a prune passed the cursor, or when the `logId` differs because impd runs on a restored
copy of its database or an older impd changed imps after a rollback. An impd without the
`eventCursor` feature ignores the cursor and sends the snapshot.

`events.list({ after, logId, limit })` reads the same log one page at a time, up to 100 events by
default and 1,000 at most. It returns the events, `hasMore`, and the `after` and `logId` to pass on
the next call. With no `after`, it returns the snapshot and the head `seq`.

Resume from the `seq` of the last event the reader received that is not a snapshot event or a
`Reset`. A snapshot event carries the head `seq`, so a cursor taken from one skips the rest of a
snapshot that a drop cut short. After a `Reset`, drop the cursor until the next event that is not a
snapshot event. A stream opened with a cursor also sends `Position` events; resume from those too.
With a token limited to some imps, the next resume then skips the events of the other imps. A stream
opened with no cursor sends no `Reset` and no `Position`, so a client that knows neither kind still
reads it.

### Events

Every event has `v` (the format version, now `1`), `at` (when impd wrote it), `seq` (its place in
impd's log; a snapshot event instead carries the `seq` of the newest event when the snapshot was
taken), `logId` (the log it comes from) and `ev` (its kind). Skip any kind or field the reader does
not know.

| `ev`                | Fields                                                   | When                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImpAdded`          | `reason` (`snapshot` or `created`), `imp`                | Each imp as the stream opens, then each new imp.                                                                                                                      |
| `ImpChanged`        | `reason`, `imp`, `detail` for some reasons               | A change to an imp's record, such as its state, pid, leases or error, with a `reason` from the table below.                                                           |
| `ImpRemoved`        | `imp`, as its record was last                            | The imp left this host, by `impz rm` or a move away: its VM, disk and checkpoints here are gone.                                                                      |
| `CheckpointAdded`   | `name` (the imp's), `checkpoint`                         | A checkpoint.                                                                                                                                                         |
| `CheckpointRemoved` | `name`, `checkpoint`                                     | A checkpoint deleted.                                                                                                                                                 |
| `GovernorDecision`  | `decision`, `name`, `trigger`, `usedMib`, `budgetMib`, … | The RAM governor admitted or refused a boot or a wake, or slept an imp to make room.                                                                                  |
| `AgentExec`         | `name`, `actor`, `actorName`, `tty`, `command`           | The imp's agent took an `impz exec --agent`; `command` is the program, never its args.                                                                                |
| `Reset`             | none                                                     | impd no longer holds the events after the reader's cursor; the snapshot follows.                                                                                      |
| `Position`          | none                                                     | On a stream opened with a cursor: the stream has read the log through `seq`. It follows a snapshot after a `Reset`, and each read past events the reader may not see. |

`imp` has the shape `impz ls --json` prints, so a reader can keep its own copy with no second call.
The `reason` of an `ImpChanged` event is one of these:

| Reason     | Meaning                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `booted`   | A cold boot finished.                                                                                                        |
| `woke`     | A wake from a memory snapshot finished.                                                                                      |
| `slept`    | The imp went to sleep: on request, idle, or for the governor (`detail.trigger`).                                             |
| `stopped`  | The imp stopped, or a new imp is ready without a boot (a fork or a restore from backup).                                     |
| `failed`   | A boot, wake or sleep failed; `imp.error` holds the cause.                                                                   |
| `repaired` | impd found the VM or the snapshot gone and corrected the record.                                                             |
| `adopted`  | impd started and found the imp's VM still running.                                                                           |
| `held`     | A hold was set or cleared, or a lease acquired or released (a renew emits nothing).                                          |
| `restored` | A checkpoint restore finished.                                                                                               |
| `resized`  | `impz disk resize` changed the imp's disk size.                                                                              |
| `updated`  | `impz set` changed the imp's CPU limit, weight, vCPUs or HTTP port, or a [move](./hosts.md#moves) set or cleared `imp.move`. |
| `exposed`  | The imp became public or tailnet-only, or got a new credential.                                                              |
| `released` | A forced sleep or stop ended the imp's leases; `detail.released` is how many.                                                |

A timing `detail` comes with `booted`, `woke`, `slept` and `restored`: `durationMs`, `steps`
(milliseconds per step, as impd logs them), `trigger` and, for a boot, `coldBootReason`. `slept`
also has `prepareMs`, the work before `durationMs` (disk room, a young guest's wait, the shrink):
the sleep started at `at` less both.

An event's `imp.leases` is `{ leases: [], otherCount }`: the stream checks each event against the
reader's imps, not its fields, so it carries no lease owners ([leases](./leases.md#owners)). A
`GovernorDecision` `refused` adds `neededMib` and `protectedCount`, never the imps' names.

### Guarantees

- impd writes each event in the same database transaction as the change it describes, from the one
  place that writes the imp or checkpoint row. So impd writes an event for every change to an imp's
  record, its own repairs included, except a change to the last activity or a lease renew. The log
  keeps the event of a commit even when impd stops right after it. An event that fails the schema is
  still left out of the stream, as below.
- Events leave in the order the writes landed.
- The stream marks its place in the log before it reads the snapshot, so no change falls between the
  two. A change under way may come in the snapshot and again after it; each event carries the whole
  imp, so a repeat is harmless.
- A slow reader gets every event impd still keeps, at its own pace. impd keeps 7 days of events, at
  most 100,000. When a stream falls behind the oldest event impd keeps, a stream opened with a
  cursor gets `Reset` and the whole snapshot again. A stream opened without one ends, and a
  reconnect sends the snapshot.
- `impz events` reconnects by itself after impd ends the stream, impd restarts or the network drops:
  after 1 s, then twice as long each time, at most 15 s. It gives up after five ends in a row; a
  stream that lasted 10 s starts the count again. Each reconnect prints the snapshot again and a
  line on stderr.
- An imp that [moves](./hosts.md#moves) here comes as `ImpAdded` with `imp.move` set to `receiving`,
  then `ImpChanged updated` with no `move` at the commit: `stopped`, or `sleeping` after a warm
  move. The source sends `ImpRemoved`.
- `ImpRemoved` comes with no `ImpChanged stopped` before it when the imp was running, and its
  `imp.state` is the last state written. It means the VM, the disk and the checkpoints are all gone;
  no `CheckpointRemoved` comes for them.
- An event that fails the event schema, a bug in impd, is left out of the stream: oRPC would end the
  stream on it. impd counts it in `imp.events.dropped` and logs it, at most once per event type
  every 5 minutes. A dropped event can leave a client stale until it reconnects. An imp whose own
  record fails the schema is left out of every snapshot too, so it stays hidden across reconnects,
  and each stream that opens adds 1 to the counter for it.
- A dashboard stream ends when its session expires and at any logout. The browser reconnects if its
  session is still valid, and resumes after the last event it read that set its cursor, so it
  refetches only what the replayed events change. After a `Reset`, or a reconnect before any event
  set its cursor, it refetches everything.
- oRPC sends a keep-alive comment every 5 s, so an idle stream stays open through a proxy. Measured
  on 2 October 2026 with two 25 s gaps between events: through the [HTTPS](./https.md) listener,
  each event came 5–14 ms after its change; over the tailnet to impd's API, 73–91 ms. Neither path
  buffered or dropped the stream.

## The API audit log

impd writes one row for each call that changes something: every procedure except the reads, plus
each exec, console, attach and SSH session as it opens (`exec-agent` for `impz exec --agent`), each
`impz proxy` tunnel as `tunnel:<port>`, and each reverse forward as `reverse:<path or port>`
(`reverse:auto` for a socket the agent names). A row has the time, the procedure, the caller, the
imp it named, the outcome (`ok` or the error code) and how long the call took. It has no column for
the call's input, only the procedure name (which holds a tunnel's port or a forward's path), the
imp's name and a short detail, so a secret's value never reaches it. An `images.add` from a registry
also keeps, as its detail, the reference the pull resolved by digest (`busybox@sha256:…`), so the
row of an add of a moving tag such as `:latest` records the bytes it took.

```sh
impz audit --kind api          # every imp, newest first
impz audit box --kind api      # the calls that named box
```

| Caller      | Means                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| `token`     | A call with the API token: the CLI, the SDK, `impz mcp`.                      |
| `dashboard` | A call with a dashboard session, or an exec on its ticket.                    |
| `ssh`       | A session through the [SSH gateway](./ssh.md).                                |
| `tailnet`   | A call from a [tailnet identity](./tokens.md#tailnet-identity).               |
| `oauth`     | A call from an MCP client signed in through [impd's OAuth](./mcp.md#sign-in). |
| `service`   | A call from a [service client](./mcp.md#service-clients) of the public route. |

The `oauth` caller is a sign-in to impd. An `oauth` secret is unrelated: a refresh token the broker
trades for access tokens to another service ([oauth secrets](./connectors.md#oauth-secrets)).

impd writes the row after it answers, so the log never slows a call, and a failed write is logged.
It keeps the newest 10,000 rows across all imps. A row holds the imp's name with no link to the imp,
so it outlives `impz rm`.

The broker's log, `impz audit` with no `--kind` (or `--kind broker`), is a different table: the
requests an imp sent with a credential ([connectors](./connectors.md)).

## Telemetry

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, impd starts the OpenTelemetry SDK and sends metrics and
traces over OTLP (HTTP and protobuf). Without it, impd loads no SDK and every instrument does
nothing. The exporters read the standard variables themselves, such as `OTEL_EXPORTER_OTLP_HEADERS`
([configuration](./configuration.md#telemetry)).

| Metric                      | Kind      | Attributes  | Meaning                                     |
| --------------------------- | --------- | ----------- | ------------------------------------------- |
| `imp.lifecycle.transitions` | counter   | `reason`    | Imps created, changed or removed.           |
| `imp.lifecycle.duration`    | histogram | `reason`    | Boot, wake, sleep and restore times, in ms. |
| `imp.governor.decisions`    | counter   | `decision`  | Admissions, refusals and sleeps.            |
| `imp.imps`                  | gauge     | `state`     | Imps in each state.                         |
| `imp.ram.used`              | gauge     |             | RAM the awake imps own, in MiB.             |
| `imp.ram.budget`            | gauge     |             | `IMP_RAM_BUDGET_MIB`.                       |
| `imp.cpu.usage`             | gauge     |             | Cores the running imps used, together.      |
| `imp.cpu.utilization`       | histogram |             | Each running imp's CPU per sample, in %.    |
| `imp.cpu.throttled`         | counter   |             | Time CPU limits held imps back, in s.       |
| `imp.network.io`            | counter   | `direction` | Bytes the guests received and sent.         |
| `imp.awake.time`            | counter   |             | Time imps spent running, in s.              |
| `imp.disk.used`             | gauge     |             | Disk the imps take on their own, in bytes.  |
| `imp.host.reboot_needed`    | gauge     |             | 1 while a kernel oops needs a reboot.       |
| `imp.events.dropped`        | counter   | `ev`        | Events left out of the stream as invalid.   |

The CPU, network and awake metrics come from impd's 5 s sample ([CPU limits](./cpu-limits.md)).
`imp.awake.time` adds up sample intervals, so it misses the boot or wake itself and up to 5 s before
each sleep or stop; `awakeMs` in the API counts the whole span. `imp.disk.used` reads impd's
disk-usage pass (every 5 min, and soon after a create or destroy): the bytes destroying each imp
would free, together. No metric carries an imp's name, so the series count stays the same as imps
come and go. Each boot, wake, sleep and restore is also a span (`imp.boot`, `imp.wake`, `imp.sleep`,
`imp.restore`) with the imp's name and trigger, and a child span for each step.

# Session logs

A session started with `log` keeps its output on the host, within the bounds under
[What is kept](#what-is-kept). A client can then read output that the agent's ring no longer holds,
and the output of a generation that has ended: after the session exited, after the imp stopped, and
after a cold boot. The log uses the same offsets and `gap` rules as a
[resume](../architecture/guest/sessions.md#generations-boots-and-offsets). Nothing changes for a
session started without `log`.

When you need a session's output beyond what the ring holds, or after the session ended, start the
session with `log`, as below. Then read its log through the CLI or the [API](#api).

```sh
impz console dev --session build --log      # start a logged session (attaching changes nothing)
impz sessions logs dev                       # every log of the imp, newest first
impz sessions log dev build                  # the newest log of `build`, raw, to stdout
impz sessions log dev build <generation> --from 1048576
impz sessions log-rm dev build               # delete the logs of `build`
```

Starting the session wakes the imp, as any exec does. Listing, reading and deleting logs never wake
or boot it: the logs live on the host.

To log a session, pass `log: true` on the start that creates it. A session that already runs stays
unlogged, even when a later start with `log` attaches to it, and every session is unlogged by
default.

Each log belongs to one generation, and every API read names it. A cold boot, a restore or a
replacement starts a new generation, and so a new log: impd never joins two generations into one
output. Bytes a log does not hold are always reported as a `gap`.

## API

| Where                  | What                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/exec` `start`        | `log: true`, with a `session` that this start creates. `started.output.log` is `{ enabled: true }` when impd keeps the log, and `{ enabled: false }` when the imp's agent predates session logs (the old agent runs until the imp's next cold boot). An attach to a logged session also shows it. |
| `sessions.logs`        | `{ name, session? }` → every generation's log: `session`, `executionGeneration`, `bootId`, `state` (`live` or `ended`), `logStart`, `logEnd`, `bytes`, `end?`, `exitCode?`, `complete`, `stopped?`, `startedAt`, `endedAt?`.                                                                      |
| `sessions.readLog`     | `{ name, session, executionGeneration, from, limit? }` → `{ offset, gap?, data, log }`. `data` is a `Blob` of raw pty output, at most 1 MiB, from one segment; read on from `offset + data.size` until `data` is empty.                                                                           |
| `sessions.deleteLog`   | `{ name, session?, executionGeneration? }` → `{ deleted }`. A live generation stops being logged.                                                                                                                                                                                                 |
| `system.info.features` | `sessionLog: true`. An older impd drops `log` unread, so check this first.                                                                                                                                                                                                                        |

Reads follow the ring's rules:

- `from` below `logStart`, or in a hole the tap left, is a `gap`: the bytes `[from, offset)` are not
  in the log, and the data starts at `offset`. It can start inside an escape sequence.
- `from` equal to `logEnd` returns no data.
- `from` past `logEnd` fails with `INVALID_RESUME`, data `{ end: logEnd, bufferStart: logStart }`.
- A generation that has no log fails with `NOT_FOUND`.

`complete` is true when the log holds every byte of a generation that ended with an exit that impd
saw: `logStart` is 0, there is no hole, and `logEnd` equals `end`. A generation that a stop or a
cold boot ended has no `end`, as the agent never reported one. Its log ends where impd's tap last
read.

In the SDK (`@impz/client`), `openExec` and `openConsole` take `log`, and `client.sessions` has
`logs`, `readLog` and `deleteLog`.

## What is kept

| Variable                       | Default | Bound                                                                                                    |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `IMP_SESSION_LOG_MAX_MIB`      | 16      | One generation's log. The log keeps at least the newest half of this bound; older segments go.           |
| `IMP_SESSION_LOG_IMP_MAX_MIB`  | 64      | One imp's logs together. Ended logs go first, oldest first; then the largest live log's oldest segments. |
| `IMP_SESSION_LOG_MAX_AGE_DAYS` | 7       | An ended generation's log goes this long after it ended.                                                 |
| `IMP_SESSION_LOG_IMP_MAX_LIVE` | 8       | Live logs per imp. A session past it runs unlogged.                                                      |

impd writes a log in segments of half its bound, and before each new segment it checks the host's
free space against `IMP_DISK_RESERVE_GIB`, as for every other write
([disk reserve](../architecture/storage/disk-space.md#disk-sizes)). A segment the reserve refuses
stops the log for good: `stopped: 'disk_full'`, and the session runs on unlogged. When an imp's logs
pass `IMP_SESSION_LOG_IMP_MAX_MIB` with no ended log left to remove and every live log down to one
segment, its newest live log stops the same way: `stopped: 'imp_limit'`.

A logged session's program waits for impd, as on a slow terminal, rather than lose bytes: the agent
holds the program's output while its 256 KiB ring could drop bytes impd has not read, for at most 5
s at a time. Past that, as when impd is down, the session runs on and the log gets a hole. After one
such 5 s stall with no tap, the output runs on unheld until a tap attaches again.

A host crash loses at most the last second of output, and the log never returns bytes that did not
reach the disk ([daemon](../architecture/guest/sessions.md#session-logs)).

## What survives

| Event                  | The log                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Sleep and wake         | Goes on. A sleep detaches impd's tap; impd taps again after the wake, from the log's end. |
| impd restart           | Goes on from the log's end. Output past 256 KiB and 5 s while impd was down is a hole.    |
| Stop, crash, cold boot | The generation ends; its log stays.                                                       |
| Checkpoint restore     | Stays. A restore is a cold boot: the running generation ends.                             |
| Fork, template         | Not copied. A fork or a template is a new disk; the log is not on the disk.               |
| Backup and restore     | Not backed up.                                                                            |
| Move to another host   | Not carried. The source deletes it with its copy of the imp.                              |
| `impz rm`              | Deleted.                                                                                  |

## Privacy

Output can hold secrets: a token a program prints, a password typed at a prompt that echoes.

- Reading a log needs `exec` on the imp, as attaching does, and the audit log records each read.
  Listing the logs needs `read`; the list holds no output.
- The log lives under the imp's directory on the host, `imps/<id>/session-logs/`, mode 0700, which
  the guest cannot reach. It goes nowhere else: no backup, fork, template or move carries it.
- `impz sessions log-rm`, the age bound and `impz rm` delete it. A generation that
  `impz sessions log-rm` deletes, live or ended, leaves a tombstone,
  `session-logs/.deleted/<generation>`, so no impd logs it again, a restarted one included. The
  tombstone goes once the guest agent no longer lists the generation, or the imp stops.
- impd does not trust the guest: every generation, boot id and session name an agent reports must
  have the form the real agent gives it before impd uses it, and a log's directory must be a child
  of the imp's `session-logs/`.

Start a session without `log` when its output should never reach the host's disk.

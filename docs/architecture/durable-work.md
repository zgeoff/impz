# Durable work

Some work changes something outside the database, such as a VM, a disk or a file, and must either
finish or unwind when the process stops halfway. Three tools carry that work across a restart: an
event log that records each change with a sequence number, operations whose fixed steps resume or
undo, and reconcilers that look at the system on a timer and start operations. They live in
`packages/durable`, which holds no imp words: the caller names each kind of operation, event and
reconciler, and owns the database.

## One transaction for a change and its record

Each write of the package runs on a Kysely transaction that the caller passes in. A domain write,
the step that made it and the event that describes it therefore commit together, or none of them
commits. Nothing else keeps a record and the state it describes in step, so a caller must never
commit a domain write in one transaction and its event in another.

The caller adds `durableMigrations` to its own Kysely migrator. Its tables are `events`,
`event_log`, `operations`, `operation_steps` and `reconcilers`, and its migration names start with
`durable_`.

## The event log

Each event row gets a sequence number from SQLite's `AUTOINCREMENT`, which never reuses a number,
even after the rows above it are removed. A reader keeps the sequence number of the last event it
saw and reads the events after it, so a reader that disconnects misses nothing that is still in the
table.

`pruneEvents` keeps the events younger than `EVENT_MAX_AGE_MS`, but never more than the newest
`EVENT_MAX_ROWS`, and records the highest sequence number it removed. A reader whose cursor sits
below that number gets a reset in place of events, because the events it would read next are gone.
The reader then starts again from a snapshot.

The migration gives each database a random log ID. A new log ID tells a reader that the database
file was replaced, and that its cursor means nothing there. A copy of the file carries the same log
ID.

## Operations

An operation is one piece of long work, such as a build, split into steps in a fixed order. The
operation row and one row per step record how far it got, so a process that starts after a crash
reads which step was running.

Each step runs its effect outside the database, then commits its success, any domain write the step
returns and its event in one transaction. A crash can therefore land in only two places: before a
step's commit, with the step's effect done or half done, or between two commits, where nothing is in
doubt. After a restart, `recover` runs each operation that had not ended. An operation that stopped
between two commits goes on with its next step. For a step that was running, its own restart rule
decides:

| Rule      | Use it for a step that…                               | After a restart                                                           |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `rerun`   | gives the same result when it runs twice              | the step runs again, and the operation goes on                            |
| `fail`    | can't run twice, but its effect can be undone         | the operation fails as `interrupted`, and the undo runs                   |
| `unknown` | has an effect that can't be observed, such as a guest | the operation ends `unknown`; nothing reruns, so the effect never repeats |

The undo runs when a step fails, when the operation is cancelled, or when a `fail` step was running
at a restart. It runs for each step that succeeded, and for each step that wrote an undo record,
last step first. A step writes its undo record before its effect, such as the name of the file it is
about to create, so the undo finds what to remove even when the process stopped halfway through the
step. An undo whose commit a crash cut off runs again after the restart, so an undo must be safe to
run twice. When an undo throws, the operation ends `failed` with the code `undo_failed`, and the
remaining undos never run, so the caller's own checks find what is left.

A cancel is saved on the operation row first, so it survives a restart. The runner then aborts the
signal of the running step. After the step ends, the undo runs and the operation ends `cancelled`. A
queued operation ends `cancelled` without running a step.

A caller may give an operation a retry key. The same key with the same kind and params returns the
operation that holds it, and the same key with another kind or other params is a conflict. The
params are compared in a canonical form, so the order of their keys makes no difference. A key stays
taken for `RETRY_KEY_KEEP_MS` after its operation ends, and `pruneOperations` removes an operation
`OPERATION_KEEP_MS` after it ends.

`waitForChange` waits for an operation, or any other row, to change. Each commit of the runner
notifies a change signal that carries no data, and the waiter reads the row again. The waiter takes
the next signal before it reads, so a commit that lands between its read and its wait still wakes
it.

## Reconcilers

A reconciler is a check that runs on an interval: it looks at the system, decides what should
change, and returns an outcome of `changed` or `unchanged` with a summary. A reconciler never
changes a VM, a disk or an artifact itself. It starts an operation through its context, so the
change gets steps, a record and an undo.

Each reconciler runs one pass at a time. A trigger runs a pass now. A trigger that arrives during a
pass runs one more pass after it, however many triggers arrive. A pass that throws counts as an
error, and the next pass waits for the interval × 2ⁿ after n errors in a row, at most 10 × the
interval. The wait is a random point between half and all of that, so reconcilers that fail together
don't retry together.

The runner keeps the last result of each reconciler in memory, and saves it to the `reconcilers`
table only when the outcome differs from the saved one. A reconciler that runs several times a
second and finds nothing to do therefore writes nothing. The runner reads the saved results when it
starts, so a restart doesn't write an outcome that is already saved. When it stops, the runner
aborts the signal of each running pass and waits for the pass to end.

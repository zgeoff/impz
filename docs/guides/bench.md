# Benchmarks

`impz bench` times how long impd takes to create, wake and restore imps on your own hardware. It
runs each step on 1 imp, then on 4, 16 and 64 at once, and reports the 50th, 95th and 99th
percentile of each. It records the machine and its state with the numbers, because the same step
takes a different time on another kernel, under nesting, or with a cold boot-template cache. Compare
two runs on one machine to decide whether a change makes impd faster.

## Run it

Point the CLI at the host, as for any other command, and run:

```sh
impz bench                                  # create, wake and restore at 1, 4, 16 and 64
impz bench wake --concurrency 1,8 --samples 50
impz bench create,sleep --memory 512m --label rack-7 --json > bench.json
```

The bench makes its own imps, named `bench-<run>-<concurrency>-<n>`, and removes each of them when a
concurrency ends and again when the run ends, whether it passes or fails. It leaves every other imp
alone, but its imps take RAM from them while it runs, so the RAM governor may put idle imps to
sleep. Run it on a host with no work you need fast.

It prints one line per concurrency to stderr while it runs, then the report to stdout: a table, or
the whole report as JSON with `--json`.

## Scenarios

Each scenario brings an imp to where its timed step starts, which the bench does not time, then
times that step as the client sees it.

| Scenario     | Before the timed step                              | The timed step                    |
| ------------ | -------------------------------------------------- | --------------------------------- |
| `create`     | removes the imp                                    | `impz new`, until impd answers    |
| `wake`       | wakes or creates the imp, then puts it to sleep    | `impz wake`                       |
| `wake-young` | stops and starts the imp, then puts it to sleep    | `impz wake` of a young guest      |
| `restore`    | wakes the imp and makes a checkpoint, once per imp | `impz restore` to that checkpoint |
| `sleep`      | wakes or creates the imp                           | `impz sleep`                      |

`--awake <duration>` keeps the imp awake that long before a scenario puts it to sleep. A
`wake-young` run with no wait times the wake that
[young guests](../architecture/lifecycle/sleep-and-wake.md#young-guests) describes.

## Settings

| Flag             | Default            | Effect                                                         |
| ---------------- | ------------------ | -------------------------------------------------------------- |
| `--concurrency`  | `1,4,16,64`        | how many imps take the timed step at once, one run per value   |
| `--samples`      | `20`               | the fewest timed steps per concurrency; 64 at once take 64     |
| `--memory`       | the host's default | each imp's memory                                              |
| `--image`        | the host's default | each imp's image                                               |
| `--awake`        | `0`                | how long an imp stays awake before a scenario puts it to sleep |
| `--label`        | none               | a name for the machine, kept in the report                     |
| `--limit-p50-ms` | none               | fail when the median of any concurrency passes this many ms    |

## The report

Each row holds a scenario at one concurrency:

- `samples` counts the timed steps that succeeded, and `failed` counts each step impd refused, by
  its error code, such as `RAM_BUDGET_EXCEEDED` when the imps outgrow the RAM budget. A step that
  failed before its timed part counts as `arrange <code>`.
- `p50`, `p95` and `p99` come from the client's own clock, so they hold the round trip to impd.
- `impd p50` is impd's own duration of the step, from the event stream.
- `mem file` is the size on disk of each memory snapshot a `sleep` wrote.

The report holds the host: its kernel, CPU model and CPU count, whether impd runs nested inside
another VM, its huge-page setting, its storage backend, and the versions of impd, Firecracker and
the guest kernel. It records the host's state before and after the run: the boot templates ready,
the free 2 MiB pool, and how many imps were awake. An impd older than the bench lacks the host
facts, and the report shows them as unknown.

The command exits 1 when a concurrency took no sample, or when a median passes `--limit-p50-ms`. It
prints the report first.

## Compare two builds

Numbers from two machines do not compare. To compare two builds of impd, run the bench against each
on the same machine, in turn, more than once. CI does this for a branch:
[the bench job](../runbooks/development.md#the-bench-job) runs a baseline and the branch on one
runner and writes the table to its summary.

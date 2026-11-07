# Spike: cold reads in a wake on huge pages

This spike measures designs that speed up the wake of an imp on 2 MiB pages, to pick the one to
build. In such a wake, the page handler process copies each 2 MiB block of the imp's memory file
into the guest at the guest's first touch, and the handler reads each block through its read-only
memory map of the file. A design must keep restores, the starts of new imps from a boot template
that impd locks in the page cache, as fast as they are.

## Question

On the production imp host, whose imps live on ZFS, a wake on 2 MiB pages takes a median of 509 ms
in its `agent` step, from the guest's resume to the guest agent's answer to a ping. On 4 KiB pages
it took 143 ms ([the wake spike](../wake-huge-pages/README.md)). Where does that time go, and which
design brings it to 143 ms or less, with restores as fast as before?

## Answer

- When the page cache lacks the memory file, the handler's reads of the file take nearly all of the
  `agent` step. With the file in the page cache, a wake on a CI runner took 13 to 26 ms in `agent`.
- On ZFS, Firecracker writes the memory file at a sleep into ZFS's own cache and none of it into the
  page cache, so the handler reads every block cold at the next wake: about 7 ms a block in CI, and
  461 ms for 58 blocks in one production wake. On XFS, the file stays in the page cache.
- Each row compares one runner's code without the design and with it (without → with), in median ms
  with one wake at a time. Compare within a row:

  | Design                                                        | Filesystem | `agent`     | Whole wake    | Restore   |
  | ------------------------------------------------------------- | ---------- | ----------- | ------------- | --------- |
  | Read the file's data into the page cache after a sleep        | ZFS        | 217.5 → 13  | 280 → 65      | 59 → 61   |
  | At a wake, read the blocks the last wake touched, in parallel | ZFS        | 112 → 16    | 165 → 81      | 73 → 74.5 |
  | The same, on a guest that reads 100 MiB every 200 ms          | XFS        | 146 → 151.5 | 229 → 256.5   | 69 → 71.5 |
  | Read each block with one `pread`, in place of the map         | ZFS        | 200 → 71    | 273.5 → 136.5 | 76 → 94.5 |

- In the prototype, the read after a sleep added a median of 237 ms to each sleep. It holds page
  cache equal to the file's data until the kernel takes it back under memory pressure.
- The runs never measured the production host. An estimate: the production wake of 58 blocks, at the
  0.4 ms a warm block cost in CI (13 ms for 31 blocks), takes about 25 ms.

Build the read after a sleep, started once the sleep returns, and keep huge pages on.

## Run it

The bench workflow, `.github/workflows/bench.yml`, compares the last commit of a `bench/**` branch
with its parent, and turns huge pages on for a branch name that holds `huge-pages`. To rerun the
first row, commit the two bench diffs first and the design's diff last. With `<name>` as a short
name for the run:

```sh
git switch -c bench/huge-pages-<name> origin/main
git apply docs/design/spikes/wake-cold-reads/prototypes/bench-cold-cache.diff
git commit -am "chore(bench): wake from a cold page cache"
git apply docs/design/spikes/wake-cold-reads/prototypes/bench-zfs-pool.diff
git commit -am "chore(bench): run the imps on a zfs pool"
git apply docs/design/spikes/wake-cold-reads/prototypes/warm-after-sleep.diff
git commit -am "perf(daemon): read a slept imp's memory file into the page cache"
git push origin HEAD
```

Expect: in about 40 minutes, a job summary whose `wake` row at concurrency 1 is about 75% faster.
Then delete the branch. [results.md](./results.md#setup) gives each design's diff, the runner and
the versions.

## Results

- [results.md](./results.md): every run, the page cache each design costs, restores, and the
  sections of the issue that builds the pick.

## Untested

The runs never measured a wake on the production host, or a ZFS wake of a busy guest.
[results.md](./results.md#untested) gives the test that settles each.

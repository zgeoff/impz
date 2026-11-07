# Results: memory file reads in wakes on huge pages

These are the runs behind the [spike's answer](./README.md#answer). Each run benched one prototype,
the candidate, against the same code without it, the baseline, on one CI runner. Two runners differ
more than two sides of one run, so compare a candidate with the baseline of its own run.

## Terms

| Term             | Meaning                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory file      | the file of a sleeping imp's guest memory, which each sleep writes anew                                                                                                                                                     |
| page handler     | the process beside Firecracker that serves a guest on 2 MiB pages: on the guest's first touch of a 2 MiB block, it copies the block in from the memory file, which it reads through a read-only `mmap` of the file, the map |
| cold read        | a read of a block that the page cache does not hold, which goes to the filesystem                                                                                                                                           |
| data block       | a 2 MiB block of the memory file that holds data; the handler copies zeros for any other block, with no read                                                                                                                |
| `load` step      | the part of a wake in which Firecracker loads the snapshot and then resumes the guest, so the guest first runs at its end                                                                                                   |
| `agent` step     | the part of a wake from the end of `load` until the guest agent answers a ping                                                                                                                                              |
| restore          | the start of a new imp from a boot template, a memory snapshot of a booted guest whose memory file impd locks in the page cache                                                                                             |
| conversation imp | in the [wake spike](../wake-huge-pages/results.md#every-wake-by-page-size), an imp that wakes for each chat message and sleeps after a minute idle                                                                          |

The [wake spike](../wake-huge-pages/README.md) found that a wake on the production host takes a
median of 143 ms in `agent` on 4 KiB pages and 509 ms on 2 MiB pages.

## Setup

Every run used the bench job, `.github/workflows/bench.yml`, on a GitHub `ubuntu-24.04` runner with
4 vCPUs, 15,983 MiB of memory, Linux 7.0.0-1017-azure and KVM. The job compares the last commit of a
`bench/**` branch, the candidate, with that commit's parent, the baseline. A branch name that holds
`huge-pages` reserves 3,072 pages of 2 MiB and runs impd with `IMP_HUGE_PAGES=2M`. Each side built
its own host image, so each side ran its own page handler.

Each run took 3 rounds of `impz bench create,wake --concurrency 1,4 --samples 20 --memory 256m`.
That gives 60 timed wakes a side with one wake at a time, and 60 with four at a time. The bench
wakes each imp once before it times any wake, and the tables leave that wake out. Each imp went to
sleep as soon as it woke.

The bench changes for these runs sat in the baseline commit, so both sides of a run ran them. The
[prototypes](./prototypes/) folder holds each change as a diff:

| Diff                                                        | What it changes                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [bench-cold-cache.diff](./prototypes/bench-cold-cache.diff) | runs only `create,wake` at 1 and 4; before each timed wake, drops every memory file from the page cache with `dd oflag=nocache`, then runs `echo 1 > /proc/sys/vm/drop_caches` on the runner, because the data dir is an XFS image in a file on a loop device, and the runner's page cache holds that file's pages too |
| [bench-hot-cache.diff](./prototypes/bench-hot-cache.diff)   | on top of the cold diff, leaves the page cache as the sleep left it                                                                                                                                                                                                                                                    |
| [bench-busy-guest.diff](./prototypes/bench-busy-guest.diff) | on top of the cold diff, gives each imp 512 MiB, with a process that reads 100 MiB of `/dev/shm` every 200 ms                                                                                                                                                                                                          |
| [bench-zfs-pool.diff](./prototypes/bench-zfs-pool.diff)     | on top of the cold diff, runs impd on a ZFS pool in a sparse file, and leaves the page cache as the sleep left it                                                                                                                                                                                                      |

The ZFS pool took the properties of `deploy/zfs-pool.json`, `lz4` compression among them, and an ARC
capped at 1 GiB. The ARC is ZFS's own cache, apart from the page cache. The runner installed
`zfsutils-linux` 2.2.2 and used the zfs module of its kernel.

The candidates, each against the code without it:

| Candidate                                                             | What it changes                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [warm after the sleep](./prototypes/warm-after-sleep.diff)            | when impd's sleep has written the memory file, it runs the handler binary in a mode that reads every data block through a map of the file, so the page cache holds them at the next wake                                                                                           |
| [working-set prefetch](./prototypes/working-set-prefetch.diff)        | the handler writes the data blocks that the guest faults in the first second of a wake to a file beside the memory file; at the next wake, as soon as the handler starts, 8 threads read those blocks with `pread` into buffers, and the handler serves each fault from its buffer |
| [one `pread` per block](./prototypes/pread-per-block.diff)            | the handler reads each data block with one `pread` into a buffer, in place of a read through the map                                                                                                                                                                               |
| [readahead of the whole file](./prototypes/readahead-whole-file.diff) | the handler starts the kernel's readahead of the whole memory file, with `posix_fadvise(POSIX_FADV_WILLNEED)`, when it starts                                                                                                                                                      |

The runs, each named for its filesystem, its cache and its candidate:

| Run                      | Bench diffs in the baseline | Candidate                   |
| ------------------------ | --------------------------- | --------------------------- |
| [zfs-warm][zm]           | cold, ZFS                   | warm after the sleep        |
| [zfs-prefetch][zw]       | cold, ZFS                   | working-set prefetch        |
| [zfs-pread][zp]          | cold, ZFS                   | one `pread` per block       |
| [xfs-cold-prefetch][cw]  | cold                        | working-set prefetch        |
| [xfs-hot-prefetch][hot]  | cold, hot                   | working-set prefetch        |
| [xfs-busy-prefetch][bw]  | cold, busy guest            | working-set prefetch        |
| [xfs-cold-readahead][cn] | cold                        | readahead of the whole file |

The figures come from impd's `woke pid`, `asleep in` and `restored boot template` lines in the
`bench-results` artifact of each run:

```text
woke pid 336 in 69ms spawn=18ms handler=5ms load=11ms agent=25ms resumed=2ms; page handler faults=30 blocks=30 serve=27ms
```

`blocks` counts the data blocks that the handler served. `serve` is the handler's time on faults
over the whole wake: the guest faults in the `load` step's resume, in `agent` and after it. A
restore's figure is the sum of its `restored boot template` line's steps from the guest's resume to
the agent's answer: `resume`, `parked`, `disk`, `patch`, `claim` and `agent`. In them, impd sends
the guest a claim with the imp's name, network and disk, and waits for its agent.

## Where a wake's time goes

Each figure is the baseline's median with one wake at a time, in milliseconds. The production row is
one wake of a conversation imp in that host's journal on 5 November 2026.

| Run                     | Filesystem, page cache before the wake | `agent` | `serve` | Blocks | `serve` per block |
| ----------------------- | -------------------------------------- | ------- | ------- | ------ | ----------------- |
| [xfs-hot-prefetch][hot] | XFS, as the sleep left it              | 26      | 27      | 31     | 0.9               |
| [xfs-cold-prefetch][cw] | XFS, dropped                           | 74.5    | 80      | 31     | 2.6               |
| [xfs-busy-prefetch][bw] | XFS, dropped, busy guest of 512 MiB    | 146     | 153.5   | 41     | 3.7               |
| [zfs-prefetch][zw]      | ZFS, as the sleep left it              | 112     | 119     | 31     | 3.8               |
| [zfs-pread][zp]         | ZFS, as the sleep left it              | 200     | 210     | 31     | 6.8               |
| [zfs-warm][zm]          | ZFS, as the sleep left it              | 217.5   | 227.5   | 32     | 7.1               |
| production              | ZFS, as the sleep left it              | 438     | 461     | 58     | 7.9               |

`serve` also counts the faults at the end of `load` and after `agent`, so it can exceed `agent`. In
the two XFS runs that differ only in the page cache, a hot cache cut `agent` by 48.5 ms and `serve`
by 53 ms, so the handler's cold reads make up the difference. On XFS, a sleep writes the memory file
through the page cache, and the next wake finds it there. On ZFS, the sleep writes the file into the
ARC, and the page cache holds none of it. The handler's map then faults in each 4 KiB page through
ZFS. The three ZFS baselines took 112 to 217.5 ms on three runners.

## Each candidate

Each cell is the median in milliseconds, baseline to candidate. `Whole wake` is the time of the
`woke pid` line.

| Run                      | Wakes at a time | Whole wake      | `load`       | `agent`       | `serve`       |
| ------------------------ | --------------- | --------------- | ------------ | ------------- | ------------- |
| [zfs-warm][zm]           | 1               | 280 → 65        | 31 → 21      | 217.5 → 13    | 227.5 → 11    |
| [zfs-warm][zm]           | 4               | 434 → 145       | 107 → 73.5   | 258 → 20.5    | 287.5 → 19    |
| [zfs-prefetch][zw]       | 1               | 165 → 81        | 22 → 34.5    | 112 → 16      | 119 → 19      |
| [zfs-prefetch][zw]       | 4               | 298 → 220       | 65.5 → 133.5 | 174.5 → 26    | 199 → 30      |
| [zfs-pread][zp]          | 1               | 273.5 → 136.5   | 39 → 28      | 200 → 71      | 210 → 71.5    |
| [zfs-pread][zp]          | 4               | 441.5 → 288     | 120.5 → 106  | 244.5 → 105   | 275.5 → 111.5 |
| [xfs-cold-prefetch][cw]  | 1               | 161 → 163.5     | 15 → 36      | 74.5 → 59.5   | 80 → 58       |
| [xfs-cold-prefetch][cw]  | 4               | 407.5 → 440.5   | 40.5 → 128   | 284 → 229     | 308 → 259.5   |
| [xfs-hot-prefetch][hot]  | 1               | 69 → 74         | 9 → 15       | 26 → 25.5     | 27 → 27       |
| [xfs-hot-prefetch][hot]  | 4               | 129 → 180       | 23 → 78      | 48.5 → 41     | 54 → 49.5     |
| [xfs-busy-prefetch][bw]  | 1               | 229 → 256.5     | 11 → 52      | 146 → 151.5   | 153.5 → 157   |
| [xfs-busy-prefetch][bw]  | 4               | 716.5 → 1,097.5 | 35 → 216     | 576.5 → 765.5 | 632 → 872.5   |
| [xfs-cold-readahead][cn] | 1               | 136 → 133.5     | 15 → 11      | 68 → 68       | 74 → 72       |
| [xfs-cold-readahead][cn] | 4               | 420 → 423.5     | 34 → 21.5    | 315 → 330.5   | 329.5 → 335.5 |

The warm step cut every figure on ZFS. The prefetch cut `agent` on ZFS, but its reads ran beside the
snapshot load, and `load` grew 1.6 to 2 times. On XFS with the cache dropped, the baseline read 31
blocks in 80 ms, at about 800 MB/s, and the suspected cause of the prefetch's small gain is that the
runner's disk gives parallel reads no more throughput; no run measured the disk alone. `load` grew
2.4 to 3.2 times. With the XFS cache as the sleep left it, the prefetch's reads still ran beside the
snapshot load, and the whole wake took 39% longer with four at a time. In the busy guest, the
prefetch's list grew to as many as 87 blocks, about twice what a wake faulted, and the whole wake
took 53% longer with four at a time.

## The cost of a hot cache

| What                        | Figure                                                        | Source                                     |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| The warm step of each sleep | median 237 ms, p90 261 ms, in 135 sleeps                      | [zfs-warm][zm], `warm=`                    |
| A sleep's whole time        | median 416 ms → 722 ms, over the sleeps at both concurrencies | [zfs-warm][zm], `asleep in`                |
| Data in one memory file     | 31 to 32 data blocks: 54 MiB on XFS, 20 MiB on ZFS with `lz4` | every run's `asleep in`                    |
| Data in a busy guest's file | 162 MiB on XFS                                                | [xfs-busy-prefetch][bw]                    |
| Page cache per sleeping imp | its data blocks times 2 MiB: 62 to 64 MiB in these runs       | `blocks=` of each wake after the warm step |

In the prototype, the warm step ran inside impd's sleep, before the `asleep in` line, and so it
added its whole time to each sleep. impd holds the imp's lock for a sleep, so a request to wake the
imp waits until the sleep ends. A warm step that starts after the sleep returns adds nothing to the
sleep's time.

The page cache that the warm step fills is not locked, so the kernel takes it back under memory
pressure, and a wake after that reads cold, as a wake without the warm step does. Locking the pages,
as impd locks a boot template's memory file, would keep each wake fast and take that RAM from the
host for as long as the imp sleeps. The runs never measured a lock.

The production host reserves 20,480 MiB of its 32,768 MiB as 2 MiB pages, and the ARC, impd and the
page cache share the rest. The wake spike's conversation imps' memory files held a median of 196 MiB
on disk, after `lz4` compression, so each takes at least 196 MiB of page cache when warm. This spike
never counted the production host's sleeping imps, so it gives no total.

## Restores

Each cell is a restore's median from the resume to the agent's answer, in milliseconds, baseline to
candidate. `create` is the bench's median for a whole create with one at a time, from the run's job
summary.

| Run                      | One at a time | Four at a time | `create`  |
| ------------------------ | ------------- | -------------- | --------- |
| [zfs-warm][zm]           | 59 → 61       | 109.5 → 118    | 225 → 231 |
| [zfs-prefetch][zw]       | 73 → 74.5     | 140 → 150      | 191 → 195 |
| [zfs-pread][zp]          | 76 → 94.5     | 154.5 → 172    | 237 → 259 |
| [xfs-cold-prefetch][cw]  | 89 → 94       | 191 → 185      | 176 → 182 |
| [xfs-hot-prefetch][hot]  | 88 → 93       | 178 → 179.5    | 172 → 173 |
| [xfs-cold-readahead][cn] | 73 → 72       | 154 → 158      | 142 → 143 |

The warm step and the prefetch leave a restore's path as it is, and their restores moved by −3% to
+8%. One `pread` per block changes a restore's reads too. A template's memory file sits locked in
the page cache. Through the map, the handler copies each block once, from the page cache into the
guest. With `pread`, it copies each block from the page cache into a buffer, and again into the
guest. Its restores took 24% longer with one at a time and 11% longer with four.

## Pick a design

Each cut is the change in the whole wake on ZFS against its own run's baseline, so the cuts compare
across runs.

| Design                        | Effort                                                   | Risk                                                                                                                                                                          | Whole-wake cut, one at a time | Whole-wake cut, four at a time |
| ----------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------ |
| Warm after the sleep          | 1 impd PR and a handler mode, about 150 lines with tests | page cache of at least 196 MiB per sleeping conversation imp; a cold wake once the kernel takes it back                                                                       | 77%                           | 67%                            |
| Working-set prefetch          | 1 handler PR and 1 impd PR, about 400 lines with tests   | whole wakes on XFS up to 53% longer; a list file to keep beside each snapshot                                                                                                 | 51%                           | 26%                            |
| One `pread` per block         | 1 handler PR, about 10 lines                             | restores 11% to 24% longer; on XFS with a hot cache, `agent` went from 37.5 to 44 ms in [an earlier bench run][pr]                                                            | 50%                           | 35%                            |
| Lock each sleeping imp's file | 1 impd PR, beside the template lock                      | the RAM leaves the host for as long as each imp sleeps                                                                                                                        | not measured                  | not measured                   |
| Turn huge pages off           | 1 host config change                                     | wakes go back to the 143 ms `agent` median of 4 KiB pages, and restores to a median `agent` of about 1,500 ms ([the wake spike](../wake-huge-pages/results.md#fix-or-accept)) | not measured                  | not measured                   |

Pick: warm after the sleep. It made the largest cut at both concurrencies, and it leaves restores
and the handler's fault path as they are. Start the warm step after the sleep returns, so that it
adds nothing to a sleep's time.

Change the pick if the production host's page cache cannot hold the sleeping imps' files, so that
wakes read cold after the kernel takes the pages back. Then lock only the blocks that each imp's
last wake touched, or prefetch them at the wake.

## The delivery issue

Whoever assigned this spike files the issue that builds the pick. These are its sections.

### Outcome

A wake on 2 MiB pages on the production host takes a median `agent` step of 143 ms or less, and
restores keep their speed.

### Context

On ZFS, a sleep leaves the new memory file in the ARC and none of it in the page cache, so the page
handler's first read of each 2 MiB block through its map takes about 8 ms on the production host. A
bench on a ZFS pool in CI cut a wake's median `agent` step from 217.5 to 13 ms by reading the file's
data blocks into the page cache after each sleep: `docs/design/spikes/wake-cold-reads/results.md`
and its `prototypes/warm-after-sleep.diff`.

### Scope

- In: a warm step that reads each data block of a slept imp's memory file through a map, on the 2
  MiB path of a ZFS host, started after the sleep returns. It logs its time and the blocks it read,
  and it stops when the imp wakes or impd destroys the imp before the step ends.
- In: a test on impd's stand-ins for each behaviour in the bullet above, and a run of the bench job
  on a ZFS pool that shows the wake's figures.
- Out: the warm step on XFS, where the file stays in the page cache after a sleep; locking the
  pages; a list of the last wake's blocks; any change to the handler's fault path or to restores.

### Acceptance

- [ ] A bench run on a ZFS pool in CI shows a wake's median `agent` step with one wake at a time
      under 50 ms, and a restore median within 10% of the baseline.
- [ ] The `asleep in` median of the same run stays within 10% of the baseline.
- [ ] After the release, the production host's journal shows a median `agent` step of 143 ms or less
      over a day of wakes on 2 MiB pages.

## Untested

- The runs never measured a wake on the production host. To settle it, read the `agent` steps in the
  host's journal after the release.
- The runs never woke a busy guest on ZFS, whose memory file holds more data blocks. To settle it,
  run the bench with [bench-busy-guest.diff](./prototypes/bench-busy-guest.diff) on top of
  [bench-zfs-pool.diff](./prototypes/bench-zfs-pool.diff).
- The runs never ran the warm step on XFS, or locked the pages. To settle the first, run the bench
  with [warm-after-sleep.diff](./prototypes/warm-after-sleep.diff) on top of
  [bench-hot-cache.diff](./prototypes/bench-hot-cache.diff).
- The runs never measured how long the production host's page cache keeps a warmed file. To settle
  it, read the `woke pid` lines after the release: a wake whose `serve` per block is near 8 ms read
  cold.

## Follow-ups

- Build the warm step, as the delivery issue sets out.
- Count the sleeping imps on the production host and the data in their memory files, to size the
  page cache that the warm step needs.

[hot]: https://github.com/zgeoff/impz/actions/runs/42324808352
[cw]: https://github.com/zgeoff/impz/actions/runs/42324711264
[bw]: https://github.com/zgeoff/impz/actions/runs/42325074307
[cn]: https://github.com/zgeoff/impz/actions/runs/42324761579
[zw]: https://github.com/zgeoff/impz/actions/runs/42326408450
[zp]: https://github.com/zgeoff/impz/actions/runs/42326454179
[zm]: https://github.com/zgeoff/impz/actions/runs/42326510676
[pr]: https://github.com/zgeoff/impz/actions/runs/42316397486

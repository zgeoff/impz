# Spike: slow wakes on huge pages

This spike measures where a wake's time goes on a production imp host since the host moved its imps
from 4 KiB to 2 MiB memory pages in November 2026. It decides whether to fix impd and its page
handler, change the host or accept the cost. A wake loads a sleeping imp's memory snapshot from disk
and resumes its guest, and impd logs each wake's steps in a `woke pid` line of the host's journal.

## Question

Since the host booted onto 2 MiB pages at 08:32 local time on 3 November 2026, the median wake has
taken 3 times as long. Which step of the wake holds the extra time, and which change at the boot
caused it?

## Answer

- The `agent` step, from the guest's resume to the guest agent's first answer to a ping, holds the
  extra time. Its median went from 143 ms in 72 wakes from 1 to 3 November, on 4 KiB pages, to 509
  ms in 58 wakes from 3 to 4 November, on 2 MiB pages.
- The host config change caused it. The change reserved a fixed pool of 2 MiB pages and set
  `IMP_HUGE_PAGES=2M`, so impd now wakes each imp through its page handler: a process that copies
  each 2 MiB block of the memory file into the guest when the guest first touches the block. The
  kernel and impd 6.3.2 stayed the same across the boot.
- Each imp's wakes stay slow long after its first wake on the pool. An imp that wakes often took 104
  to 205 ms in `agent` in 12 wakes before the boot, and 346 to 4,536 ms in 25 wakes after it.
- On two test imps of 512 MiB, wakes took 219 to 353 ms from the resume to the agent's answer, and
  starts from a boot template, whose memory file impd keeps in the host page cache, took 104 and 107
  ms.
- The handler reads each block through a memory map, which faults up to 512 pages of 4 KiB when the
  file is out of the page cache. On a workstation, that read took 15.5 ms a block, and one `pread`
  took 3.2 ms. No run timed the handler on the host, so this cause is suspected.

Log the handler's faults and read time with each wake. If the reads hold most of the `agent` step,
change the handler to read each block with one `pread`.

## Run it

**CAUTION:** these steps create, sleep and wake an imp on the host that your saved `impz` login
points at. On a production host, run one imp at a time.

1. From a checkout, create the imp, put it to sleep and wake it with the CLI from source, which is
   `impz`:

   ```sh
   bun packages/cli/src/main.ts new wakeprobe-small --memory 512m --no-backup
   bun packages/cli/src/main.ts sleep wakeprobe-small
   bun packages/cli/src/main.ts wake wakeprobe-small
   ```

   Expect: each command exits 0.

2. On the host, read the wake's line:

   ```sh
   journalctl -u imp-host --since '-10min' | grep -v 'podman\[' | grep 'wakeprobe-small woke pid'
   ```

   Expect: one line. `handler=` in it means the imp is on 2 MiB pages. Compare its `agent=` with the
   143 ms median on 4 KiB pages.

3. From the checkout, remove the imp with `bun packages/cli/src/main.ts rm wakeprobe-small`.

## Results

- [results.md](./results.md): every wake by page size, what changed, the test imps and the
  workstation read test.

## Untested

The spike's runs never timed the handler's faults or its read time on the host.
[results.md](./results.md#untested) gives the test that settles it.

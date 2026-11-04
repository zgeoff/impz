# Wake results on huge pages

These are the tables behind the [spike's answer](./README.md#answer). They compare the wakes that
impd logged on the target host, a production imp host, on 4 KiB pages before the host's boot at
08:32 on 3 November 2026 with the wakes on 2 MiB pages after it. The `agent` step of a wake runs
from the guest's resume until the guest agent answers a ping, and its median went from 143 to 509
ms.

## The host and the journal

The target host is a nested-KVM guest with 8 vCPUs and 32 GiB of memory on an AMD EPYC 7513, and it
runs Linux 6.18.54 and ZFS. Local time is UTC+11.

To read impd's wake and sleep lines, run this on the host. The container runtime logs a copy of each
line, and `grep -v` drops the copies:

```sh
journalctl -u imp-host --since '2026-11-01 08:12' --until '2026-11-04 23:33' -o short-iso \
  | grep -v 'podman\[' | grep -E ' woke pid|asleep in'
```

The window starts when impd 6.3.2 started, and ends before the [test imps](#the-test-imps) ran.

## Restores and wakes

impd starts an imp from a memory snapshot by a restore or by a wake:

- A restore starts a new imp from a boot template: a memory snapshot of a booted guest that impd
  keeps for each image. impd locks each template's memory file in the host page cache, so a restore
  reads its memory from RAM.
- A wake resumes a sleeping imp from the memory snapshot it took when it went to sleep. That memory
  file is new at each sleep, and Firecracker writes it through ZFS, whose cache is not the page
  cache.

On 4 KiB pages, Firecracker maps the memory file into the guest, and the kernel reads each 4 KiB
page when the guest first touches it. On 2 MiB pages, Firecracker hands each fault to the page
handler, a small process that impd starts beside it. For each 2 MiB block that the guest touches,
the handler copies in the block from its own read-only map of the memory file. Where the file holds
no data, the handler copies in a block of zeros.

## What changed at the boot

| What           | Before the boot, 1 to 3 November         | After the boot, 3 November 08:32           | Source                            |
| -------------- | ---------------------------------------- | ------------------------------------------ | --------------------------------- |
| Kernel         | Linux 6.18.54, the same initrd           | Linux 6.18.54, the same initrd             | the kernel's `Command line` lines |
| impd           | 6.3.2                                    | 6.3.2 until 15:49, 6.4.0 after             | the host config's version pins    |
| Host config    | no pool of 2 MiB pages                   | a fixed pool of 10,240 pages of 2 MiB      | the host config change            |
| Memory backing | each imp on 4 KiB pages, with no handler | each imp on 2 MiB pages, through a handler | `handler=` in each line           |

The host switched to the new config at 08:28 and rebooted at 08:32. The same switch stopped every
imp on 4 KiB pages, so each one booted cold onto the pool at its next use. The first wake after the
boot, at 15:47, ran on impd 6.3.2 and took 970 ms in `agent`. Every later wake ran on 6.4.0, which
changed nothing in the wake path, the page handler or the agent client, so the release is not the
cause.

## What each step times

impd writes one `woke pid` line when a wake ends, with impd's steps in milliseconds:

```text
imp=<imp> woke pid 36417 in 636ms spawn=59ms handler=15ms load=53ms agent=484ms resumed=11ms
```

| Step      | What impd does in it                                                |
| --------- | ------------------------------------------------------------------- |
| `spawn`   | starts Firecracker                                                  |
| `handler` | starts the page handler, on 2 MiB pages only                        |
| `load`    | has Firecracker load the snapshot, then resumes the guest's vCPUs   |
| `agent`   | waits from the resume until the guest agent answers a ping          |
| `resumed` | tells the guest agent that it woke, and reads Firecracker's version |

The guest first runs at the end of `load`, so most pages that the guest touches before its agent
answers fault in the `agent` step.

## Every wake, by page size

Each step's figure is a median in milliseconds. `agent` p90 is the 90th percentile, and `Total` is
the whole wake. `Mem file` is the median data in the memory file, from the `asleep in` line before
the wake. This doc gives each imp a made-up label for its kind: a conversation imp wakes for each
chat message and sleeps after a minute idle, a home imp is a person's long-lived workspace, and a
preview imp serves a web app's preview.

| Pages | Imps         | Wakes | Total | `spawn` | `handler` | `load` | `agent` | `agent` p90 | `resumed` | Mem file |
| ----- | ------------ | ----- | ----- | ------- | --------- | ------ | ------- | ----------- | --------- | -------- |
| 4 KiB | all          | 72    | 216   | 38      | –         | 10     | 143     | 275         | 8         | 197 MiB  |
| 4 KiB | conversation | 57    | 207   | 38      | –         | 10     | 132     | 205         | 7         | 193 MiB  |
| 4 KiB | home         | 15    | 344   | 37      | –         | 11     | 252     | 730         | 15        | 842 MiB  |
| 2 MiB | all          | 58    | 678   | 40      | 12        | 52     | 509     | 2,308       | 17        | 200 MiB  |
| 2 MiB | conversation | 53    | 624   | 41      | 12        | 52     | 484     | 2,259       | 15        | 196 MiB  |
| 2 MiB | home         | 4     | 2,542 | 62      | 8         | 54     | 2,369   | 4,478       | 85        | 781 MiB  |

The "all" row on 2 MiB pages holds one more wake, a preview imp's, at 2,289 ms in `agent`.

### One conversation imp on both sides

Conversation imp A's memory file held 183 to 213 MiB of data at each wake, before and after.

| Period                         | Wakes | `agent` min | `agent` median | `agent` max |
| ------------------------------ | ----- | ----------- | -------------- | ----------- |
| 3 November, 02:21 to 03:41     | 12    | 104 ms      | 127 ms         | 205 ms      |
| 3 November 17:26 to 4 November | 25    | 346 ms      | 512 ms         | 4,536 ms    |

### Time asleep

A long sleep can let the host drop the memory file from its caches, but a short sleep still gives a
slow wake. Home A woke 8 s after it went to sleep and took 970 ms in `agent`. Of the 53 conversation
wakes on 2 MiB pages, the 13 that came less than 2 minutes after a sleep took 294 to 2,259 ms. The
table below holds the 5 wakes from 09:00 to 18:00 on 3 November, the working hours that the
[restore tail spike](../restore-tail/README.md) studied:

| Local | Imp            | `spawn` | `handler` | `load` | `agent` | Mem file | Asleep for |
| ----- | -------------- | ------- | --------- | ------ | ------- | -------- | ---------- |
| 15:47 | home A         | 37      | 5         | 44     | 970     | 781 MiB  | 8 s        |
| 15:50 | home A         | 32      | 5         | 40     | 1,682   | 781 MiB  | 82 s       |
| 16:26 | preview A      | 31      | 5         | 32     | 2,289   | 924 MiB  | 39 s       |
| 17:26 | conversation A | 48      | 15        | 147    | 630     | 183 MiB  | 4 h 5 min  |
| 17:31 | conversation B | 34      | 9         | 43     | 506     | 175 MiB  | 4 h 6 min  |

## The test imps

At 23:41 on 4 November, two test imps of 512 MiB ran on 2 MiB pages on the target host: one idle,
and one with 150 MiB of random data in `/dev/shm`. A script ran 5 rounds. In each round it put both
imps to sleep, waited 30 s, and woke each in turn. Each figure is the `agent` step, in milliseconds.
`Restore` is the start of each imp from its boot template, when the script created it.

| Imp     | Restore | Wake 1 | Wake 2 | Wake 3 | Wake 4 | Wake 5 | Mem file |
| ------- | ------- | ------ | ------ | ------ | ------ | ------ | -------- |
| idle    | 61      | 353    | 325    | 273    | 260    | 294    | 103 MiB  |
| 150 MiB | 78      | 299    | 266    | 277    | 219    | 295    | 257 MiB  |

The guest does not read the data in `/dev/shm` on a wake, so the size of the memory file alone does
not set a wake's time. The script slept each imp about a second after its wake, and impd's
`asleep in` line then gave the imp's RAM, the memory the guest held, as 119 to 219 MiB. That is 60
to 110 blocks of 2 MiB that the guest touched while awake. `Mem file` is the data the sleep wrote to
disk.

## The workstation read test

Reading a 2 MiB block through a map of the file faults its 512 pages of 4 KiB, up to 16 pages at a
time. A short Go program on a workstation (Linux 6.6 under WSL2, on ext4) read 100 blocks of 2 MiB
of random data through a read-only private map, as the handler does, and again with one `pread` per
block. It ran each way 3 times with the file in the page cache, and 3 times after it dropped the
file from the cache:

| Page cache | Read                      | Per block    | Faults per block   |
| ---------- | ------------------------- | ------------ | ------------------ |
| hot        | through the map           | 151–220 µs   | 32 minor           |
| hot        | one `pread` into a buffer | 75–79 µs     | 0                  |
| cold       | through the map           | 15.5–16.0 ms | 15 major, 17 minor |
| cold       | one `pread` into a buffer | 3.2–3.3 ms   | 0                  |

A restore reads about 35 blocks, all hot, as the [UFFD spike](../uffd-2m-restore/README.md#findings)
found. UFFD is userfaultfd, the kernel interface that the page handler serves faults through. If the
whole `agent` step of a test imp's wake went on reads of 60 to 110 blocks, each block cost about 2
to 6 ms, between the hot and the cold read through the map. The workstation is not the target host,
so these figures show how the two reads compare, and give no cost for the target host.

## Fix or accept

| Option                                                                         | Effort               | Risk                                                                                                      | Effect                                           |
| ------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A. Accept the slower wakes                                                     | none                 | a conversation waits a median of 484 ms in `agent` on each wake                                           | restores stay at 61 to 78 ms in `agent`          |
| B. Turn huge pages off on the host                                             | 1 host config change | restores go back to 4 KiB pages, whose agent the UFFD spike timed at a median of 1,500 ms after the claim | wakes go back to 4 KiB pages: a median of 143 ms |
| C. Log the handler's faults, data blocks and read time with each wake          | 1 small impd PR      | none; one more log field                                                                                  | shows the per-block cost on the target host      |
| D. Read each block with one `pread`, or load the memory file before the resume | 1 to 2 impd PRs      | a load before the resume adds its time to `load`                                                          | removes the map's faults, if C confirms them     |

The spike recommends C, then D, with huge pages kept on, and B if D does not bring wakes near 143
ms. If C shows that the handler spends little of the `agent` step on reads, the time goes elsewhere
in the guest, and the next spike times the guest's own steps on a wake.

## Untested

- No run on the target host timed the page handler's faults or its read time during a wake. C
  settles it: per wake, log the faults, the blocks that the handler read from the file's data
  instead of zeros, and the handler's total time on those faults.
- No run compared a wake on 4 KiB pages with one on 2 MiB pages at the same time on the target host.
  impd's RAM budget for awake imps is 20,480 MiB there, and the pool takes all of it. impd lets
  guests on 4 KiB pages use the budget less the pool, which leaves them 0 MiB.
- No run timed the agent's first ping, which impd retries after 200 ms. That retry ran in both
  periods, so it is not the change, but a first ping that hangs adds up to 200 ms to a wake.

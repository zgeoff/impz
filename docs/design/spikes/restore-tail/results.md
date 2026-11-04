# Restore tail results

These are the tables behind the [spike's answer](./README.md#answer). They cover the 12 boot
template restores that impd logged on the target host from 09:00 to 18:00 local time on 3 November.
In the 5 restores whose `agent` step took 574 to 2,255 ms, against a median of 107 ms, most of
impd's steps and the guest's disk mount slowed down together. The journal holds no figure that shows
which resource of the host stalled.

## Setup

The target host is a production imp host. It is a nested-KVM guest with 8 vCPUs and 32 GiB of memory
on an AMD EPYC 7513, and it runs Linux 6.18, impd 6.4.0, Firecracker v1.17.0 and ZFS. It backs
restored guests with 2 MiB pages. The same host runs a k3s cluster beside impd.

Local time is UTC+11, so the window runs from 22:00 UTC on 2 November to 07:00 UTC on 3 November.
The host booted at 08:32 and impd built template `c4c480673be5` at 08:35, both before the window.
All 12 restores in the window used that template. impd restarted at 15:49.

To read impd's lines, run this on the host. The container runtime logs a copy of each line, and
`grep -v` drops the copies:

```sh
journalctl -u imp-host --since '2026-11-03 09:00' --until '2026-11-03 18:00' -o short-iso \
  | grep -v 'podman\[' | grep -E 'restored boot template|created in| woke pid'
```

## What each step times

impd writes one `restored boot template` line when a restore ends, and one `created in` line when
the create around it ends. The `restored boot template` line gives impd's steps in milliseconds,
then, after `; guest`, the guest agent's own steps. A sample line, shortened:

```text
imp=<imp> restored boot template c4c480673be5 as pid 26076 admit=3ms setup=192ms spawn=915ms handler=149ms load=292ms ... agent=927ms version=25ms; guest claim=79ms mount=705ms ...
```

| Step      | Logged in                | What impd or the guest does in it                                                    |
| --------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `setup`   | `restored boot template` | impd removes the imp's old memory snapshot and sets up its network tap               |
| `spawn`   | `restored boot template` | impd starts Firecracker                                                              |
| `handler` | `restored boot template` | impd starts the page handler that serves the template's memory                       |
| `load`    | `restored boot template` | Firecracker loads the template's snapshot                                            |
| `resume`  | `restored boot template` | Firecracker resumes the guest's vCPUs                                                |
| `parked`  | `restored boot template` | after the resume, impd waits for the parked guest agent to answer a ping             |
| `claim`   | `restored boot template` | impd sends the claim and waits for the guest's answer                                |
| `agent`   | `restored boot template` | impd waits from the guest's answer to the claim until the guest agent answers a ping |
| `mount`   | after `; guest`          | the guest mounts the imp's disk, from the moment it answers the claim                |
| `record`  | `created in`             | impd writes the imp's row to its database                                            |
| `clone`   | `created in`             | impd clones the imp's disk from its image on ZFS                                     |
| `size`    | `created in`             | impd grows the disk file and its filesystem to the imp's disk size                   |

The guest starts the mount before impd reads the guest's answer, so a mount can outlast the `agent`
step when impd reads the answer late.

## Every restore in the window

The imps carry made-up labels by kind: home, preview, SDK check, builder, image check and
conversation. `Local` is the time of the `restored boot template` line, which marks the end of the
restore. `Host total` is the sum of every impd step on that line, the steps not shown here included.
Every figure after `Imp` is in milliseconds.

| Local    | Imp          | setup | spawn | handler | load | parked | claim | agent | Host total | mount | record | clone | size  |
| -------- | ------------ | ----- | ----- | ------- | ---- | ------ | ----- | ----- | ---------- | ----- | ------ | ----- | ----- |
| 09:02:09 | preview A    | 282   | 600   | 35      | 223  | 62     | 257   | 574   | 2,192      | 268   | 48     | 544   | 845   |
| 11:56:36 | home B       | 10    | 36    | 14      | 9    | 20     | 9     | 90    | 201        | 66    | 11     | 66    | 103   |
| 11:56:41 | home C       | 12    | 39    | 11      | 9    | 20     | 9     | 78    | 200        | 63    | 11     | 100   | 113   |
| 11:56:56 | home D       | 192   | 915   | 149     | 292  | 440    | 228   | 927   | 3,254      | 705   | 539    | 626   | 1,274 |
| 13:19:39 | conversation | 691   | 590   | 267     | 120  | 862    | 589   | 2,255 | 5,601      | 2,271 | -      | -     | -     |
| 13:29:46 | SDK check A  | 226   | 1,175 | 19      | 118  | 186    | 56    | 1,604 | 3,430      | 1,337 | 92     | 859   | 1,491 |
| 14:58:00 | builder A    | 61    | 68    | 28      | 39   | 41     | 30    | 107   | 384        | 82    | 70     | 154   | 178   |
| 15:12:55 | image check  | 355   | 340   | 18      | 64   | 41     | 25    | 1,324 | 2,196      | 1,010 | 213    | 1,726 | 801   |
| 15:49:14 | builder B    | 13    | 38    | 13      | 18   | 40     | 9     | 86    | 226        | 44    | 18     | 90    | 91    |
| 15:51:21 | preview B    | 14    | 41    | 11      | 13   | 26     | 8     | 96    | 217        | 60    | 13     | 70    | 100   |
| 16:31:50 | SDK check B  | 9     | 48    | 15      | 38   | 4      | 15    | 70    | 259        | 46    | 11     | 79    | 174   |
| 17:20:48 | home E       | 15    | 53    | 12      | 19   | 30     | 12    | 107   | 252        | 73    | 19     | 93    | 124   |

The conversation imp already existed, so impd started it from its own disk with no create, and it
has no `created in` line. The median `agent` step of all 12 is 107 ms. The 7 restores whose `agent`
step took under 200 ms are the fast ones.

## Each slow step against the fast median

The first row gives each step's median in the 7 fast restores, in milliseconds. Each row after it
divides a slow restore's step by that median. `size` is left out, because the conversation imp has
none and the other 4 add nothing to the `clone` column.

| Imp               | setup | spawn | handler | load | parked | claim | agent | mount | record | clone |
| ----------------- | ----- | ----- | ------- | ---- | ------ | ----- | ----- | ----- | ------ | ----- |
| Fast median in ms | 13    | 41    | 13      | 18   | 26     | 9     | 90    | 63    | 13     | 90    |
| preview A         | 22x   | 15x   | 3x      | 12x  | 2x     | 29x   | 6x    | 4x    | 4x     | 6x    |
| home D            | 15x   | 22x   | 11x     | 16x  | 17x    | 25x   | 10x   | 11x   | 41x    | 7x    |
| conversation      | 53x   | 14x   | 21x     | 7x   | 33x    | 65x   | 25x   | 36x   | -      | -     |
| SDK check A       | 17x   | 29x   | 1x      | 7x   | 7x     | 6x    | 18x   | 21x   | 7x     | 10x   |
| image check       | 27x   | 8x    | 1x      | 4x   | 2x     | 3x    | 15x   | 16x   | 16x    | 19x   |

`setup` and `spawn` run 8 to 53 times their medians in every slow restore, and neither reads the
imp's disk. The guest's `mount` reads only the imp's disk, and it runs 4 to 36 times its median in
the same restores. Steps that share nothing but the host slowed down in the same restores, so the
host stalled as a whole. `handler`, `parked` and `claim` slowed down in only some of them.

## The two suspected causes

| Suspected cause                                 | Restore                         | When                                                          | `agent` step       |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------------------------- | ------------------ |
| The first restore after impd or the host starts | builder B                       | the first restore after the 15:49 impd restart                | 86 ms              |
| The first restore after impd or the host starts | preview A                       | the first restore in the window, 30 min after the host booted | 574 ms             |
| The first restore after impd or the host starts | 2 home imps, outside the window | 08:35, 3 minutes after the host booted                        | 2,834 and 1,039 ms |
| Several restores at the same time               | home D                          | started about 10 s after home C ended                         | 927 ms             |

A fresh start can come with a slow restore: the first 3 restores after the host boot were slow. The
first restore after the impd restart was fast, and 4 of the 5 slow restores in the window came 3 to
7 hours after the boot, so a start explains at most the restores just after it. None of the 5 slow
restores overlapped another restore.

## Wakes

A wake resumes an imp from its own memory snapshot and mounts no disk. impd logs it in a `woke pid`
line. The window holds 5 wakes, and their `agent` steps took 506 to 2,289 ms. Earlier on 3 November,
before the host booted at 08:32, 12 wakes of the conversation imp took 104 to 205 ms in the same
step. The spike did not study the wake path.

## Other work on the host

The kernel log for the window holds no hung-task, soft-lockup, clocksource or I/O error line.

Before two slow restores, impd logged heavy disk work:

- At 15:12:47 impd finished its only image build in the window, a 2 GiB image, and at 15:12:52 it
  destroyed the disk of the imp that ran the build. The image check's restore ended at 15:12:55.
- At 08:55:48 impd finished a backup that added 7.2 GB. Preview A's restore ended 6 minutes later,
  at 09:02:09.

impd logged no work in the minutes before the other 3 slow restores.

A log collector in the k3s cluster read files from disk all window, so it is a third candidate
source of disk load. It hit its 384 MiB memory limit, and the kernel killed it for memory at 09:11,
11:19, 14:43 and 15:38. By 15:38 the kernel had counted 1.66 billion page-cache refaults in its
cgroup, which means the collector read the same files from disk again and again. Each kill came more
than a minute away from a slow restore. Whether the collector's reads line up with the slow restores
is unknown, because the journal holds no disk figures.

## Bench at a quiet time

`impz bench create` ran on the host at 19:01 local time on 4 November, with 7 imps awake, one create
at a time, 10 samples and 512 MiB imps. The host had no template for 512 MiB imps, so impd booted
the kernel for the first 3 creates while it built one. The other 7 creates restored that template.
Every figure is in milliseconds:

| Step    | Min | Median | Max |
| ------- | --- | ------ | --- |
| `setup` | 9   | 17     | 50  |
| `spawn` | 41  | 68     | 80  |
| `agent` | 67  | 97     | 158 |
| `mount` | 49  | 72     | 134 |
| `clone` | 277 | 376    | 534 |

The bench's clones took longer than the window's fast clones. Each one started about 1 s after impd
destroyed the previous bench imp, and the spike never tested whether that destroy slows the clone.

The bench timed each create from its API call to the imp's change event. The median, 863 ms, is a
restored create, and it also counts the clone, the disk grow and the event's trip back to the bench.
The p95, 1,838 ms, is one of the kernel boots.
[bench-create-idle.json](./results/bench-create-idle.json) holds the bench report.

## Untested

- Which resource stalls: CPU time lost to the outer hypervisor, CPU time taken by the imps awake at
  the time, memory reclaim, or the disk under the ZFS pool. A run on a test host that loads each
  resource in turn while it restores templates would settle it. So would the host's pressure-stall
  figures from `/proc/pressure/` and its steal time from `/proc/stat`, logged with each restore.
- Restores at a concurrency above 1. The bench ran one at a time, to keep load off the production
  host.

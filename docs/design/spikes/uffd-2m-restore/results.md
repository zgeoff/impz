# UFFD restore results

Each table gives the median of each mark, in milliseconds, over the restores of each mode. The marks
are impd's restore steps: `agent` is the time from the claim's answer to the first ping that finds
the agent unparked. Every template is a 2 vCPU, 2048 MiB guest restored with a fresh copy of a 32
GiB disk, built from `imp-base:0.29.0`. Each run's raw lines sit beside this file, and
`uffd-spike summary` prints its table from them.

## Modes

| Mode          | Backend | What the handler does                                                  |
| ------------- | ------- | ---------------------------------------------------------------------- |
| `file`        | File    | nothing: Firecracker maps the memory file                              |
| `uffd-demand` | UFFD    | copies each page in when the guest faults on it                        |
| `uffd-fill`   | UFFD    | copies the template's data and the boot working set in before resuming |

The working set is the union of the pages that the `record-demand` restores faulted in before the
agent came up unparked. Fault counts give the pages faulted in after load, after the resume and
after the claim.

## 2 MiB pages, target host

The host is a nested-KVM guest with 32 GiB of memory on an AMD EPYC 7513, running Linux 6.18 and
Firecracker v1.17.0. `file` restores a 4 KiB template and both UFFD modes restore a 2 MiB one. The
run has 1 warm File restore, 3 recording restores, then 21 interleaved rounds of the three modes,
with a reserved pool of 1,100 2 MiB pages. Its raw lines are in
[results-host.jsonl](./results-host.jsonl).

| Mode            | Runs | Load | Parked | Claim | Agent  | Faults load/resumed/claimed | Fill |
| --------------- | ---- | ---- | ------ | ----- | ------ | --------------------------- | ---- |
| `record-demand` | 3    | 7.6  | 16.0   | 6.6   | 61.0   | 2/29/4                      |      |
| `file`          | 21   | 4.4  | 77.3   | 74.0  | 1499.8 |                             |      |
| `uffd-demand`   | 21   | 6.5  | 15.3   | 7.0   | 60.8   | 2/29/3                      |      |
| `uffd-fill`     | 21   | 23.6 | 3.1    | 6.6   | 59.8   | 2/0/0                       | 20.8 |

The spread of `agent` over the 21 rounds:

| Mode          | Min   | Median | p90    | Max    |
| ------------- | ----- | ------ | ------ | ------ |
| `file`        | 318.9 | 1499.8 | 2882.8 | 3273.7 |
| `uffd-demand` | 50.8  | 60.8   | 87.0   | 95.6   |
| `uffd-fill`   | 50.3  | 59.8   | 68.2   | 87.7   |

- A `uffd-demand` boot faults in 34 to 36 distinct 2 MiB blocks, 2 to 6 of them after the claim. The
  handler serves a 2 MiB fault in a median of 450 µs, about 20 ms in each boot.
- The working set holds 35 blocks, and the fill copies 49: the blocks that hold data and the working
  set.
- `file` restores split into two groups: most take 1.4 to 3.3 s, and the last five take about 330
  ms. The guest's mount step takes a median of 767 ms under `file` and 44 ms under UFFD, with the
  same disk copy, so the difference comes from the memory backend.
- impd's own restores on the host in the same hours report `agent=` of 450, 3,136 and 4,016 ms.
- No restore saw a REMOVE event or a handler error.

## 4 KiB pages, development PC

The PC is a WSL2 guest with KVM, which runs Firecracker v1.17.0 inside the `imp-host:3.0.2` image.
The run has 1 warm File restore, 2 recording restores, then 3 interleaved rounds of the three modes,
all on a 4 KiB template. Its raw lines are in [results-pc-4k.jsonl](./results-pc-4k.jsonl).

| Mode            | Runs | Load | Parked | Claim | Agent | Faults load/resumed/claimed | Fill |
| --------------- | ---- | ---- | ------ | ----- | ----- | --------------------------- | ---- |
| `record-demand` | 2    | 42.3 | 69.6   | 67.3  | 252.1 | 6/1126/4385                 |      |
| `file`          | 3    | 35.9 | 15.3   | 19.5  | 148.9 |                             |      |
| `uffd-demand`   | 3    | 32.9 | 69.9   | 60.0  | 257.7 | 7/1149/4366                 |      |
| `uffd-fill`     | 3    | 35.4 | 9.0    | 5.5   | 56.6  | 0/0/82                      | 27.0 |

- The on-demand handler serves a fault in a median of 23 µs, and about 150 ms of service time lands
  in each boot.
- The fill copies 20,744 pages: 19,015 that hold data and the 5,772 pages of the working set, which
  overlap. The first fill takes 131.6 ms with a cold page cache.

## Free 2 MiB blocks

A 2 GiB guest on 2 MiB pages needs 1,024 free 2 MiB blocks for its Full snapshot. With surplus pages
from `vm.nr_overcommit_hugepages`, the PC's snapshot fails with
`Cannot dump memory: Guest memory error: Bad address (os error 14)` at about 305 free blocks. One
memory compaction leaves the PC at 301 blocks, and later at 48. The target host's free blocks range
from 327 to 1,385 within the same day, and most of its available memory is page cache. A pool set
through `vm.nr_hugepages` fills all 1,100 pages at once.

# UFFD restore results

Each table gives the median of each mark, in milliseconds, over the restores of each mode. The marks
are impd's restore steps: `agent` is the time from the claim's answer to the first ping that finds
the agent unparked. Every template is a 2 vCPU, 2048 MiB guest restored with a fresh copy of a 32
GiB disk, built from `imp-base:0.29.0`.

## Modes

| Mode          | Backend | What the handler does                                                  |
| ------------- | ------- | ---------------------------------------------------------------------- |
| `file`        | File    | nothing: Firecracker maps the memory file                              |
| `uffd-demand` | UFFD    | copies each page in when the guest faults on it                        |
| `uffd-fill`   | UFFD    | copies the template's data and the boot working set in before resuming |

The working set is the union of the pages that the `record-demand` restores faulted in before the
agent came up unparked. Fault counts give the pages faulted in after load, after the resume and
after the claim.

## 4 KiB pages, development PC

The PC is a WSL2 guest with KVM, which runs Firecracker v1.17.0 inside the `imp-host:3.0.2` image.
The run has 1 warm File restore, 2 recording restores, then 3 interleaved rounds of the three modes.

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
- The guest grows its root filesystem in under 5 ms, because the disk is grown offline before the
  restore, as impd does.

## 2 MiB pages, development PC

Not run yet. The run needs a free 2 MiB block for each block of guest memory, which the PC's
fragmented memory does not have:

- A 2 GiB build fails at the snapshot with
  `Cannot dump memory: Guest memory error: Bad address (os error 14)`, with about 305 free 2 MiB
  blocks against the 1,024 the guest needs.
- One memory compaction leaves 301 free blocks, under the 1,100 that the run's gate asks for.
- A 512 MiB proof needs 280 free blocks, and the PC has 48.

## 2 MiB pages, target host

Not run yet. The target is a nested-KVM host, on which each page that the guest touches costs a
nested page-table fill.

| Mode          | Runs | Load | Parked | Claim | Agent | Faults load/resumed/claimed | Fill |
| ------------- | ---- | ---- | ------ | ----- | ----- | --------------------------- | ---- |
| `file`        |      |      |        |       |       |                             |      |
| `uffd-demand` |      |      |        |       |       |                             |      |
| `uffd-fill`   |      |      |        |       |       |                             |      |

# UFFD restore on 2 MiB pages

This spike measures whether a boot template restored through a userfaultfd (UFFD) page handler on 2
MiB pages brings an imp's agent up in under 250 ms after the claim. impd restores a template from a
4 KiB memory file through Firecracker's File backend. A 2 MiB template restores only through UFFD,
so the spike runs its own handler beside Firecracker and times each restore with impd's own marks.
[results.md](./results.md) holds the full numbers.

## Verdict

Go. On the target host, a 2 MiB template restored through an on-demand handler brings the agent up
in a median of 60.8 ms after the claim, and no run of 21 takes longer than 95.6 ms. The File restore
of a 4 KiB template on the same host, interleaved with it, takes a median of 1,499.8 ms.

## Findings

- A 2 MiB boot touches about 35 distinct 2 MiB blocks of the template, and only 2 to 6 of them after
  the claim. A 4 KiB boot faults about 5,500 pages, 4,370 of them after the claim.
- On the target host, most of the File restore's extra time lands in the guest's mount step, which
  takes a median of 767 ms under File and 44 ms under UFFD on the same disk copy. impd's own
  restores on that host fall in the same range as the harness's File restores.
- Copying the template's data in before the resume gains nothing on 2 MiB pages: the fill takes
  about 21 ms and moves that time from the parked step into the load step. An on-demand handler is
  enough, and it needs no recorded working set.
- On 4 KiB pages the on-demand handler is slower than the File backend, because each of the boot's
  thousands of faults costs a round trip to the handler. The gain comes from the page size, not from
  UFFD.
- A Full snapshot of a 2 MiB guest takes a hugetlb page for every block of guest memory, so a 2 GiB
  build needs 1,024 free 2 MiB blocks at once. A host whose memory is fragmented fails the snapshot
  with `Bad address (os error 14)`. A pool that the host reserves keeps those pages ready.
- An on-demand restore takes a pool page only for each block the guest touches: about 35 at boot,
  against the 1,024 of the configured guest memory. The guest takes more as it uses its memory. A
  pool page that a guest holds is neither KSM-mergeable nor reclaimable. The harness does not
  measure whether the kernel also reserves the guest's untouched blocks when Firecracker maps its
  memory, which decides how many imps a pool of a given size can hold.

## The harness

[`harness/`](./harness/) is a Go program, `uffd-spike`, that runs as root on a host with `/dev/kvm`
and `/dev/userfaultfd`. Each command except `summary` runs in a private network namespace, with the
template's tap made there. Firecracker runs without impd's jailer, cgroup and KSM launcher.

- `build` builds a template as impd does: it boots with `imp.template=1`, waits for the parked agent
  and the guest's minimum age, takes a Full snapshot, and digs the memory file's holes.
  `-huge-pages 2M` backs the guest with hugetlbfs.
- `restore` restores a template through the File backend or, with `-uffd`, through the handler.
  `-fill` takes a working-set file, which the handler copies in before the resume.
- `bench` interleaves File, on-demand UFFD and filling UFFD restores, after a set of on-demand
  restores that record the working set, and appends one JSON line per restore.
- `summary` prints the median of each mark for each mode.

The handler serves page faults and the balloon's REMOVE events, and records which phase each fault
fell in: load, resumed, claimed or agent. [`make-disk.sh`](./make-disk.sh) builds an imp disk from
an image as impd does, growing it offline to impd's default size.

## Running it

A 2 MiB build needs a pool of 2 MiB pages for the guest, which you free after the run.

```sh
sysctl -w vm.nr_hugepages=1100
grep HugePages_Total /proc/meminfo
uffd-spike build -firecracker fc -kernel vmlinux -system imp-system.squashfs -template tpl-4k
uffd-spike build -firecracker fc -kernel vmlinux -system imp-system.squashfs -template tpl-2m -huge-pages 2M
uffd-spike bench -firecracker fc -file-template tpl-4k -uffd-template tpl-2m \
  -disk disk.ext4 -work work -runs 21 -record-runs 3 -out results.jsonl -working-set ws-2m.json
uffd-spike summary results.jsonl
sysctl -w vm.nr_hugepages=0
```

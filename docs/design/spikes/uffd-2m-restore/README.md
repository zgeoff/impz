# UFFD restore on 2 MiB pages

This spike measures whether a boot template restored through a userfaultfd (UFFD) page handler on 2
MiB pages brings an imp's agent up in under 250 ms after the claim. impd restores a template from a
4 KiB memory file through Firecracker's File backend. A 2 MiB template restores only through UFFD,
so the spike runs its own handler beside Firecracker and times each restore with impd's own marks.
[results.md](./results.md) holds the full numbers.

## Status

The handler works on 4 KiB pages, and the 2 MiB numbers are not run yet. No go or no-go against 250
ms exists until the 2 MiB rows of [results.md](./results.md) hold numbers from the target host. Both
the development PC and the target host stop at the gate that counts free 2 MiB blocks before a 2 MiB
build. On the target host most available memory is page cache, which that count leaves out.

## Findings

- On a 4 KiB template, an on-demand handler is slower than the File backend: the median `agent=` is
  258 ms against 149 ms. The boot faults about 4,370 pages after the claim, and each costs a round
  trip to the handler.
- A handler that copies the template's data and a recorded boot working set in before the resume
  brings the median `agent=` down to 57 ms, and the fill itself takes a median of 27 ms. Most of
  that gain comes from cheap page-table fills on a host without nested virtualisation, so it is no
  forecast for a nested host.
- A 2 MiB template build needs a free 2 MiB block for every block of guest memory, because a Full
  snapshot reads every guest page. A 2 GiB guest needs 1,024 of them, and on a fragmented host the
  snapshot fails with `Bad address (os error 14)`.

## The harness

[`harness/`](./harness/) is a Go program, `uffd-spike`, that runs as root on a host with `/dev/kvm`
and `/dev/userfaultfd`. Each command except `summary` runs in a private network namespace, with the
template's tap made there.

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

The host needs a cap on surplus hugetlb pages for a 2 MiB build, which you set back to 0 after.

```sh
sysctl -w vm.nr_overcommit_hugepages=1100
uffd-spike build -firecracker fc -kernel vmlinux -system imp-system.squashfs -template tpl-4k
uffd-spike build -firecracker fc -kernel vmlinux -system imp-system.squashfs -template tpl-2m -huge-pages 2M
uffd-spike bench -firecracker fc -file-template tpl-4k -uffd-template tpl-2m \
  -disk disk.ext4 -work work -runs 21 -out results.jsonl -working-set ws-2m.json
uffd-spike summary results.jsonl
sysctl -w vm.nr_overcommit_hugepages=0
```

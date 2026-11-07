# Huge pages

With huge pages on, impd backs each imp of fixed memory with the host's pool of huge pages, the
large page size the CPU maps with one page table entry. A guest on huge pages takes fewer page
faults and fewer TLB misses, so a template restore reaches a running agent sooner. Restore and wake
run through a page handler: a small process per imp that serves each page of the snapshot as the
guest first touches it. The owner turns huge pages on for the whole host, and off is the default. An
elastic imp always runs on the host's ordinary pages, because a shrink exists to return memory to
the host, and a pool page goes back only to the pool ([elastic memory](./elastic-memory.md)).

The pool is memory the host reserves for huge pages at boot or through `vm.nr_hugepages`, and no
other process can use it. impd only reads the pool's size; the host's own config sets it, as
[the configuration guide](../../guides/configuration.md#huge-pages) describes.

## Which imps run on huge pages

impd decides at each cold boot. With huge pages on, an imp of fixed memory whose memory is a whole
number of huge pages boots on them; any other imp boots on ordinary pages. impd records the choice
in the imp's VM identity and in each snapshot it takes, because a wake back onto huge pages needs a
page handler, which a snapshot on ordinary pages never starts.

A boot template carries the choice in its key, so an imp on huge pages restores only a template
built on huge pages ([boot templates](./boot-templates.md#the-key)). A template on ordinary pages
keeps the key it would have with huge pages off.

A wake follows the snapshot. A snapshot on huge pages wakes on huge pages while the setting is on.
With the setting off, the host may have no pool, so the snapshot wakes on ordinary pages from its
memory file, and impd records the imp as on ordinary pages from then on.

## The page handler

Firecracker restores a guest on huge pages only through userfaultfd (UFFD): it maps the guest's
memory empty and hands a page handler the file descriptor on which the kernel reports each fault.
impd starts one handler per restore or wake, before Firecracker loads the snapshot.

1. impd opens the snapshot's memory file, makes a zeroed stats file in the imp's run directory, and
   starts the handler with both files as inherited descriptors, inside the imp's cgroup.
2. The handler binds its socket in the imp's run directory, which the jail binds in, owned by the
   jail's user, and drops its own privileges to that user.
3. Firecracker connects at the load, sends the guest's memory regions and the UFFD descriptor, and
   the handler checks the peer's process through the socket's credentials.
4. On each fault, the handler copies the page the guest touched from the memory file into the guest,
   or a zero page past the file's data. It serves faults on demand and never fills memory ahead,
   because a boot touches few of the guest's pages. After each fault, the handler adds to three
   counts in the stats file: the faults served, the data blocks read (the faults served from the
   memory file's data), and the time spent serving.
5. When the guest gives memory back, the kernel reports the removed range, and the handler stops
   serving it, so a later touch maps a fresh zero page.

Huge pages speed up a template restore and slow down a wake. On a nested production host, a wake on
huge pages took longer to reach a running agent than a wake on ordinary pages
([the wake spike](../../design/spikes/wake-huge-pages/README.md)). When the page cache holds none of
the memory file, the handler reads each block through the filesystem, and in a bench on ZFS those
reads took longer than the wait for the guest's agent to answer
([the cold reads spike](../../design/spikes/wake-cold-reads/results.md#where-a-wakes-time-goes)). So
impd [warms the file after each sleep](#the-warm-after-a-sleep).

The counts start at zero when a handler starts. At the end of a wake on huge pages, impd reads the
stats file and adds the counts to the wake's `woke pid` line in the journal. The line's steps before
the semicolon are impd's, in milliseconds:

```text
woke pid 4211 in 640ms spawn=58ms handler=14ms load=52ms agent=495ms resumed=11ms; page handler faults=214 blocks=151 serve=388ms
```

| Field      | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `handler=` | impd's step that starts the handler and waits for its socket                   |
| `load=`    | the snapshot load and the resume, after which the guest faults in its pages    |
| `agent=`   | the wait for the guest's agent to answer                                       |
| `faults=`  | the faults the handler served                                                  |
| `blocks=`  | the data blocks it read; each other fault got a zero page                      |
| `serve=`   | the handler's time serving faults, which overlaps impd's steps from `load=` on |

## The device

A jailed Firecracker runs as an unprivileged user, so the kernel refuses it a userfaultfd from the
system call, and it opens the userfaultfd device instead. The host container gets that device only
while huge pages are on, because the device lets a process handle faults the kernel itself takes,
which widens what a compromised process can reach. The jailer copies the device into every jail
where the container has it, and impd removes it from each jail before any guest code runs, after the
snapshot load or the boot's configuration. With huge pages on and no device, impd refuses a boot or
wake on huge pages before it starts a Firecracker, so no VM waits on a handler it cannot reach.

## The handler's lifetime

The handler holds the memory file through its descriptor, so a template that impd removes stays
readable to every imp restored from it until its handler exits.

A guest whose handler is gone waits on its next fault forever, and Firecracker never notices. So the
handler kills its Firecracker on any failure after the load connects, and exits when that
Firecracker exits. impd watches each handler it started or adopted at start, and kills the VM when
the handler is gone; the imp then fails as any VM that dies does. A failed restore or wake stops its
handler before impd boots the imp cold.

## Sleep

A guest on huge pages tracks no dirty pages, because KVM's dirty page log maps guest memory in
ordinary pages and takes away what huge pages gain. Its sleep takes a diff snapshot all the same:
Firecracker writes a diff of an untracked guest from mincore(2), which finds every huge page the
guest holds. A full snapshot would read every page the guest never touched through the handler, and
take a pool page for each.

The diff goes over a base that holds the rest of the memory. For a woken or restored imp, the base
is a copy of the file its handler serves, read through the handler's descriptor; a copy that fails
falls back to a full snapshot. A cold-booted imp has no handler, and its untouched memory is zero,
so the diff goes over an empty file. impd refuses to sleep an imp whose handler record is there but
whose handler is gone, because the diff would then miss the pages that handler served.

A template build on huge pages snapshots the same way, as a diff into an empty file.

## The warm after a sleep

After each sleep on huge pages, impd reads the new memory file's data blocks into the page cache, so
that the next wake's handler copies them from memory. The warm matters most on ZFS: a sleep there
writes the file into the ARC, ZFS's own cache, and leaves none of it in the page cache.

1. Once the imp is asleep, impd runs the handler's program, with no guest to serve, as
   `uffd-handler --count-data <memory file>`. It counts the blocks of the file that hold data, one
   block per huge page.
2. impd multiplies that count by the huge page size and compares the result with the cap that
   `IMP_WARM_CAP_MIB` sets ([the configuration guide](../../guides/configuration.md#impd)). A file
   that holds more stays cold, so that one large imp never pushes the other imps' warmed files out
   of the page cache.
3. For a file within the cap, impd runs `uffd-handler --warm <memory file>`, which reads each data
   block through a map of the file, as a wake's handler reads it.

A wake, a stop or a destroy of the imp ends its warm first, and impd's own stop ends every warm.
impd runs at most two warms at once, and a third waits for one of them to end. The kernel can take
back the page cache that a warm filled, because nothing locks it, and a wake after that reads cold.

impd logs the outcome of each warm in the journal, on a line with the imp's name:

```text
warmed the memory file in 41ms: 27 blocks of 2 MiB
left the memory file cold: its 862 MiB of data pass the warm cap of 256 MiB
stopped the memory file's warm after 12ms: the imp woke
```

## RAM

Pool pages are not anonymous memory and not file pages, so the governor reads each VM's hugetlb
count beside its proportional set size and counts it as owned, resident and unshared
([the RAM governor](./ram-governor.md#what-it-measures)). KSM cannot merge pool pages, and the
balloon's free page reporting cannot give them back to the host.

The governor admits a boot or a wake on huge pages against the pool as well as the budget. An awake
guest on huge pages can still take a pool page for each part of its memory it has not touched, so
the governor counts that remainder, and the memory of each admission still under way, as promised.
It refuses the request with `RAM_BUDGET_EXCEEDED` when the free pool cannot hold the promised pages
and the new guest's whole memory. It sleeps no imp to make pool room, because the imps it would
sleep may hold no pool pages.

The host reserves the pool out of the RAM the budget counts, and a guest on ordinary pages can never
take a pool page. On a host with a pool, the governor therefore holds a second line: the ordinary
budget, which is the budget less the whole pool. It counts every guest on ordinary pages, the locked
pages and the KSM headroom against the ordinary budget, and for a guest on huge pages only what it
holds beside its pool pages. A boot, wake or grow on ordinary pages must fit both budgets, and
enforcement sleeps imps while either one is over. A refusal that the ordinary budget makes names
that budget and its numbers. To make room under the ordinary budget, the governor counts what each
imp holds outside the pool, so it never counts a guest's pool pages as room that its sleep frees
there.

A sleeping imp of fixed memory whose snapshot is on ordinary pages, such as one that slept before
the host turned huge pages on, wakes on ordinary pages. When the ordinary budget refuses that wake,
impd boots the imp cold onto the pool instead, which costs the guest its memory but not its disk. An
elastic imp cannot run on the pool, so the refusal stands and it stays asleep with its snapshot.

Firecracker maps the pool without a reservation, so a guest that faults past an empty pool dies of
SIGBUS. The admission rule keeps that from happening while nothing else on the host takes pool
pages.

# Disk space

Imp disks are sparse and their clones are thin, so the sizes imps are given can add up to far more
than the host holds. To keep that safe, impd holds back a reserve of free space and refuses each
large write that would cut into it, counts what each imp really uses, and sweeps away what a crash
left behind without ever taking an imp's data. [Storage](./storage.md) covers the backends.

## Disk sizes

An imp's disk is a file larger than its image's filesystem, and the guest grows the filesystem to
fill it. A fork takes its source's size, a checkpoint keeps the size the disk had, and a restore or
a fork from a checkpoint takes that size back. A resize only grows a disk, because the guest's ext4
cannot shrink online. Both backends keep the disk as a file, so impd grows a disk by truncating the
file under the imp's lock. How the guest catches up depends on the imp's state:

- **Stopped**, or new before its first boot: impd grows the filesystem on the host. A filesystem
  that was not unmounted cleanly is left for the guest, since its journal must replay first.
- **Running**: impd asks Firecracker to read the file's size again, which tells the guest, and the
  agent's grow request resizes the filesystem online.
- **Sleeping**: the snapshot holds the old size, so the grow waits for the wake. A grow that fails
  stays pending for the next wake, and every cold boot grows the filesystem to fill its disk anyway.

A grown filesystem has new inode tables, which ext4 zeroes. On a sparse file those already read as
zeros, so zeroing them only allocates host space, and a grow on the host leaves them as holes. The
guest mounts its root so that an online grow zeroes them at once rather than in the background,
which still allocates that space.

## The budget

The disk budget is one ledger in impd. Each large write takes its estimate off the free space, under
a lock, until it ends, so two writes never pass on the same reading. A write that would cut into the
reserve fails with `DISK_FULL` before it touches anything. The ledger covers the writes that can be
large: a sleep's memory file, written at full size before its holes are dug; a watchdog snapshot; an
image build, which holds the unpacked tree and the ext4 file at once; an upload while it arrives; a
backup restore; and each new segment of a session log. A create and a fork take nothing, because a
thin clone writes nothing. A checkpoint or a resize is refused only once the reserve is already
reached.

The disk budget never refuses a wake: its disk and memory already exist, and a full disk must not
strand an imp's work. A sleep that is refused leaves its imp running, and the governor turns to
another imp. Each time free space falls below twice the reserve, impd warns once and marks the
storage low.

impd reads free space differently on each backend. On ZFS a write counts only once its transaction
group commits, and a destroy frees its blocks in the background, so the ledger keeps a write's hold
for a while after it ends and never counts freed space before ZFS reports it. On XFS in a loop file,
the filesystem can report room that the file's own host directory no longer has, so free space is
the smaller of the two.

Both backends also hold a little space back outside the ledger, so a destroy still runs on a full
disk: a reservation on ZFS, and a preallocated file on XFS. On a full disk, the owner can remove it
to free room.

## Usage

Each imp's listing shows two numbers. Used is what a destroy of the imp would free: its disk, its
checkpoints and its memory snapshot. Shared is what it refers to that others hold too: the image and
the source of a fork. impd runs a pass that measures every imp at start, on a timer and soon after
an imp or a checkpoint is created or removed. Listings show the last pass.

On ZFS one listing of the pool gives both numbers for every imp. On XFS a reflink leaves no count of
who holds a block, so impd reads the extents of every file, in imps, images and the backup tree
alike. An extent that one owner holds counts as that owner's, and one that two or more hold counts
as shared. The read yields between calls and stops at a time limit, so impd stays responsive. When a
pass stops before it reaches an imp, that imp keeps its last count, marked as possibly stale. impd
never asks the kernel to flush before it reads, so blocks not yet written count as their owner's.

## The sweep

A crash, or a removal that failed halfway, can leave storage that no row names. One sweep deals with
it, at start, on a timer and on `impz gc`. The sweep must be safe after a lost database. A database
restored from an older copy, or one that is gone while the pool survives, leaves every newer disk
and checkpoint without a row, and a sweep that took them would delete every imp. So the sweep takes
only what is provably impd's own and transient, such as a leftover snapshot from a fork or a backup,
or an empty directory. It keeps each disk, image and checkpoint that no row names as an orphan, and
logs it with its size and age. `impz gc --orphans` retires the orphans as a destroy would. A destroy
removes the files first and the row last, so a destroy never makes an orphan.

While impd runs, the sweep must never take storage that is about to get its row. A checkpoint's
snapshot exists before its row, an image build takes minutes, and a fork's disk is made under its
source's lock. So every operation that touches storage joins a gate from before its first storage
call until its rows commit, and the sweep runs only once nothing is in flight. Operations that start
while the sweep runs wait for it. While the sweep waits, new operations still start, and the sweep
gives up after a timeout. A backup run stays in the gate for its whole length, so a sweep that meets
one gives up. The sweep reads the database and the pool inside the gate each time, so it never acts
on a list made before.

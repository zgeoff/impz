# Storage

Every imp disk is a copy-on-write clone. An image becomes one ext4 file once, and each disk,
checkpoint and fork shares its blocks with the one it came from, so making one costs no copy and
almost no time. Two backends do this behind one interface. A host keeps one backend for its whole
life: impd marks the data directory with the backend that wrote it, and refuses to start on a data
directory the other backend wrote. Nothing converts a data directory between backends, so to bring
imps across, restore them from a backup. For the budget, the usage counts and the sweep, see
[disk space](./disk-space.md); for how an image becomes a file, see [images](./images.md).

- **XFS with reflink**, the default. Each disk, checkpoint and fork is a reflink clone of another
  file. A clone never falls back to a full copy, which would slowly fill the disk, so setup refuses
  a host without reflink. The data directory is an XFS filesystem, on a real partition or on a
  sparse loop file that the container's entrypoint sets up.
- **ZFS.** Each disk is a dataset, a checkpoint is a snapshot, and a fork is a clone. A move between
  two ZFS hosts uses ZFS to send a disk and its checkpoints to the other pool
  ([moves](./moves.md#zfs)).

Either way a disk is a sparse ext4 file, on ZFS inside its dataset, so the guest sees the same
drive, and a backup restores across backends.

## The data directory

impd keeps everything under one data directory: the database, the system files, the images, a
directory per imp with its disk, its memory snapshot, its sockets and its session logs, the jails,
the boot templates, the tailnet node's state and the TLS files. `storage/build-imp-paths.ts` builds
every one of these paths. On ZFS the root dataset is mounted on the data directory. The disks, the
images and the memory snapshots live in datasets of their own beneath it, so a checkpoint of a disk
never holds a stale memory file. impd mounts every dataset inside the container, and the host never
mounts one. At start, impd mounts them all again before it adopts or wakes a VM.

## System files

impd copies the guest kernel and the system drive into the data directory at start. It writes a
changed kernel beside the old one and renames it over the old one, so a running VM keeps its inode.
Only a cold boot reads the kernel. impd stores each system drive under its own hash and never writes
over it. A snapshot reopens its drive by path, and the guest's page cache holds blocks of those
bytes, so the bytes at that path must not change. After an agent change the old drive stays, and a
sleeping imp wakes on it with its memory and its old agent, jailed or not
([snapshot identity](../lifecycle/sleep-and-wake.md#snapshot-identity)). At start impd deletes every
drive that is not the current one and that no snapshot, live VM or boot template refers to.

## Checkpoints, restores and forks

All three run the same steps on both backends. Only the copy differs: a reflink copy on XFS, and a
snapshot or a clone on ZFS. On ZFS, the rules in [ZFS](#zfs) add steps, such as retiring the disk a
restore replaces.

- **Checkpoint.** The agent syncs and freezes the guest's filesystem, impd copies the disk, and the
  agent thaws it. The freeze carries its own timeout, so a guest whose host never thaws it thaws by
  itself. A sleeping imp wakes first, because its memory holds page cache that is not on the disk
  yet. A stopped imp needs no freeze.
- **Restore.** impd clones the checkpoint first, so a clone that fails leaves the imp as it was. It
  then kills the VM, drops any memory snapshot, swaps the clone in for the disk, and boots again if
  the imp was awake. The kill skips the guest's shutdown, because its disk and memory are being
  thrown away. A swap that fails after the kill leaves the imp stopped on its old disk, as after a
  power cut, which ext4's journal handles.
- **Fork.** impd clones a disk or a checkpoint into a new imp. A fork is disk only, because a memory
  fork would duplicate entropy and IDs across the copies. Its first boot gives it a new machine-id
  and new SSH host keys, through the [identity reset](../../guides/templates.md#identity).

A restore keeps every other checkpoint, older and newer: nothing is rolled back, and each stays a
clone of the disk it was taken from.

## ZFS

impd follows a few more rules on a ZFS host. Retiring and reclaiming follow from one fact: a dataset
cannot go while a clone or a snapshot still needs its blocks.

- **Retired datasets.** impd renames a destroyed disk, a replaced disk after a restore, and a
  removed image into a retired area instead of destroying them. It marks each snapshot that no
  checkpoint needs any more for deferred destroy, so ZFS removes it with its last clone.
- **Reclaim.** Once every snapshot on a retired dataset is marked, impd promotes the clone of its
  newest snapshot. A promote hands that clone the retired dataset's snapshots and leaves the retired
  dataset with none, so impd can destroy it. That is how a fork outlives its source, and how a
  removed image hands its blocks to the imps cloned from it. impd reclaims in the background after
  every delete, destroy and restore, and at start, after the version check and the sweep and before
  it mounts the imps' datasets. impd never promotes a clone in staging, because the promote would
  take the retired dataset's snapshots with it. A restore, a backup or a move keeps a clone in
  staging only until it renames the clone into place or destroys it.
- **Lanes.** impd runs dataset changes one at a time. Checkpoints and live forks run in a lane of
  their own, so they never wait behind a reclaim while the guest is frozen.
- **A reserve.** A dataset with nothing in it holds back a little of the pool, so a destroy still
  runs on a full pool ([disk space](./disk-space.md#the-budget)).
- **Versions.** The container's ZFS tools and the host's ZFS module must share a major version, and
  impd refuses to start when they do not. On a different minor version impd only logs a warning,
  since it runs no command a 2.x module lacks. The minimum module version below still applies.
- **Minimum module versions.** A ZFS module needs 2.3.7 on the 2.3 line or 2.4.2 on the 2.4 line,
  and no 2.2 or older release has the fix. An older module can overrun a buffer when a SIGKILL or a
  cgroup OOM kill lands during a read (openzfs/zfs#15918). impd sends both kills to Firecracker, at
  stop and at each VM's memory cap, so one can land during a read of an imp's disk. With hardened
  usercopy the kernel then oopses, the oops kills Firecracker, and its hold on the disk's dataset
  lasts until a reboot. impd refuses to start on an older module unless the host's override is set
  ([the host](../host.md#what-the-host-gives)). With the override it logs a warning at start and
  lists the same warning in `/health`.

## Crash recovery

Every multi-step change stages its new state under a name of its own and renames it into place last,
so a crash leaves a name that shows what was in flight. On XFS that rename is atomic. On ZFS, impd
settles each staging dataset at start. It finishes a restore whose old disk is already retired by
renaming its clone into place. A restore whose old disk is still there never happened, so impd
destroys its clone. impd also destroys the builds, backup clones and move streams in staging, which
are temporary, and the fork, backup and move snapshots that no running work holds. The memory
snapshot goes before a restore's swap, so neither outcome pairs it with the wrong disk. What a crash
does not explain stays for the sweep ([disk space](./disk-space.md#the-sweep)).

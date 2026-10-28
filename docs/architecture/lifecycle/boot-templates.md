# Boot templates

A cold boot spends most of its time in the guest kernel's boot before the agent answers. A boot
template skips that: impd boots one guest per shape, parks its agent before it touches any user
disk, and snapshots it. Each later cold boot of that shape restores the snapshot, and the agent
takes the imp's own values from a `claim`. The owner can turn templates off. A boot template is
unrelated to a template image, which is an image made from an imp's disk
([images](../storage/images.md#template-images)).

## The key

A template is reused only where a restore inherits exactly what a cold boot would have. Its key is a
hash of the guest kernel and the system drive, the Firecracker version and snapshot format, the host
kernel, the CPU model and its flags, the template's kernel command line, the devices, and the vCPU
count and memory size. The image is not in the key, because a template never opens a user disk.

An elastic imp never restores a template: its guest needs a hot-plug region from its boot on, and a
template has none ([elastic memory](./elastic-memory.md#limits)). At start, impd removes every
template whose key this host no longer makes, and whatever a build left half done.

## Build

A shape's first cold boot boots the kernel. Its second starts the template's build in the
background, so no create waits for it, and a shape booted once costs nothing. Builds run one at a
time, because they share one tap.

1. The build holds disk room for the whole memory, and is admitted by the governor into free room
   only, so it never sleeps an imp ([the RAM governor](./ram-governor.md#admission)).
2. impd boots a VM with nothing on its command line that names an imp, and a small placeholder disk
   at a path every template shares, since a snapshot records its drive's path.
3. The agent mounts its own filesystems, makes the inner container's cgroup, reads its own binary
   through, and parks. The read leaves the binary's pages in the guest's page cache, so a restored
   guest runs the code it never ran before the snapshot without decompressing it from the system
   drive again. A parked agent answers only `ping` and `claim`, and opens no network socket, so the
   kernel has made no TCP secrets yet.
4. impd waits until the guest is old enough for a fast wake
   ([young guests](./sleep-and-wake.md#young-guests)), pauses it, and writes the snapshot into a new
   directory, which it renames into place.

A rebuild always writes a new directory. A restored VM maps the template's memory file privately, so
impd never changes a memory file a VM may have mapped; a template it removes is renamed away and
lives on until its last VM exits.

## Restore

When the shape has a template, a cold boot starts Firecracker in the imp's cgroup and jail, loads
the template's snapshot paused with the imp's tap and vsock socket in place of the template's, seals
the jail and resumes. Meanwhile impd readies the imp's disk. Once the parked agent answers and the
disk is ready, impd points the guest's root drive at the imp's disk, which also tells the guest its
new size, and sends `claim`.

The claim carries the imp's id, hostname, addresses, gateway, DNS servers, MAC, the host's clock and
a random seed. The agent sets the clock first, so nothing after it stamps the template's time. It
credits the seed to the entropy pool and reseeds the kernel's random generator at once, sets its
MAC, waits for the disk to report the claimed size, and goes on as a cold boot does, in the same
process. It never reads the kernel command line again, since a restored guest's is the template's.

From there the imp is an ordinary cold-booted imp. A failure in the template's own steps, the load,
the resume or the parked ping, removes that build of the template and boots the kernel; the next
misses build it again. A failure from the claim on is the imp's own, and the template stays. Failed
builds and failed restores back off, and a key that keeps failing is turned off until impd restarts.
A small number of templates is kept, and past it the least recently restored one goes.

## RAM

The governor counts a restored VM as it counts every VM, without its clean file pages. The pages a
guest only reads stay clean pages of the template's memory file, which the host's page cache shares
across every imp restored from it, and a page the guest writes becomes its own anonymous page. So a
restored imp costs less than a cold-booted one at first.

A restore reads its guest's memory from the host's page cache, one page fault at a time, so a
restore after the host reclaimed those pages waits on storage for each one and takes seconds. impd
therefore locks each kept template's data pages in the page cache: once a build finishes, and for
every kept template at start. The build digs holes where the guest's memory was zero, and the lock
skips the holes, so it holds only the pages that a boot left non-zero. The governor counts the
locked pages as used RAM, because no sleep frees them, and impd releases a template's lock when it
removes the template. A lock that fails, such as over the container's locked-memory limit, leaves
the template unlocked and logged, and its restores still work at the speed of whatever the host
still caches.

## Accepted risks

Every imp restored from one template shares what its kernel made before the snapshot:

- **The boot ID** is the template's. The agent reports a random UUID it draws after the claim
  instead, so impd can still tell one boot from the next
  ([sessions](../guest/sessions.md#generations-boots-and-offsets)).
- **The slab freelist seeds** are the template's. An attacker who learns them in one imp knows them
  for every imp of that template on the host.
- **KASLR** changes nothing, because no guest has it: Firecracker loads the kernel at its link
  address, so every imp has the same kernel layout, restored or not.
- **A driver rebind** of the network device in the guest brings back the template's MAC. The tap
  still carries the traffic, and the guest's address does not change.

What the kernel makes later is the imp's own, such as the TCP sequence and timestamp secrets, made
on the first network socket after the claim, and everything drawn from the reseeded generator.

# Elastic memory

An imp has a fixed memory size by default. An elastic imp, created with a max memory, boots at its
memory size and grows toward its max when it runs low, then gives memory back when it has some to
spare. Above its memory size, the guest holds only what impd has plugged into it, and the
[RAM governor](./ram-governor.md) admits every grow first, so the budget counts all the RAM an
elastic imp grows into.

## How the guest grows

The guest grows through virtio-mem. A VM boots with its memory size plus a hot-plug region up to its
max, and the guest kernel onlines plugged memory as movable, so that an unplug can migrate pages
away. impd asks Firecracker for a plugged size, and the guest plugs or unplugs blocks in its own
time. impd counts the plugged size, never the requested one, because an unplug can stop partway. It
sends each plug or unplug under the imp's lock, which a sleep takes too, so a sleep never snapshots
a guest whose size the controller is changing. The sleep's own unplug, below, runs before its pause.

The balloon was the other way to do this. A guest that boots at its max with an inflated balloon
pays the max at every step, in RSS at boot and in a snapshot as large as the max, where virtio-mem
pays only for what is plugged. Every VM keeps a balloon at zero for free page reporting, which
returns freed guest pages to the host, and impd never inflates it.

User code runs in the agent's inner container, whose memory limit follows the guest's memory. In an
elastic guest the agent moves that limit as memory comes and goes, so plugged memory is the user's
too. After an unplug, the agent lowers the limit no further than the container's use plus a margin,
and lowers it again as the use falls, so a shrink never makes the kernel kill a user process to fit.
impd grows no guest whose agent is too old to move its limit, because that container would be killed
in memory the guest grew into.

## The controller

On each tick, the memory controller reads each awake elastic guest's available memory from the
balloon's statistics.

- **Grow.** A guest whose available memory falls below its grow mark plugs one step more, up to its
  max. The governor admits the step and the guest's page structures for it, as it admits a wake, and
  may sleep idle imps to make room. A grow it refuses leaves the guest at its size, with its own OOM
  killer. The statistics refresh on a poll, so for a while after a plug they still show the guest
  from before it, low as it was. The controller therefore grows a guest again only once its
  statistics count the last step, or once they have missed it for a few polls after the plug landed,
  so a guest gets one step each time it runs low. A grow made after such a miss waits for the
  statistics to count both steps.
- **Shrink.** A guest that could give back a step for a minute (`IMP_MEMORY_SHRINK_AFTER_S`) unplugs
  to its spare size: the least size that leaves it a grow step clear of its grow mark. A fixed
  headroom would undo itself, because in a large guest the grow mark passes it and the next tick
  would grow the guest again.
- **Stalls.** A plug or an unplug that stands still has stopped: the guest keeps what it reached,
  impd asks for exactly that, and the controller leaves the imp alone for a while.
- **Reclaim.** Before the governor sleeps any imp, idle elastic guests unplug to their spare size.
  That frees their page cache too, which free page reporting never returns.

The controller leaves alone an imp whose lock is taken, and trusts the guest's report. A guest that
reports less than it has gets grows it does not use, and the governor may sleep idle neighbours for
them, but never past its max or the budget.

## The host limit

The cgroup's hard limit on a VM follows what its guest may hold: its memory, plus what is plugged,
plus room for Firecracker and its page cache. impd moves the limit in an order that never cuts a
guest short:

- At a cold boot, when nothing is plugged yet, impd sets it to the memory and that room.
- At a wake, impd sets it to the memory plus the snapshot's plugged size before the load.
- At a grow, impd raises it before the plug.
- At a shrink, impd lowers it only once the guest holds no more than the target.
- After a restart, impd sets it from what each adopted guest holds.

## Sleep

Before the pause, a sleep unplugs the guest to its spare size, briefly and under the imp's lock.
Firecracker writes only the plugged part of the region, so an unplugged region costs a snapshot
nothing, and plugged memory costs it the write. The snapshot records the plugged size, the load
restores it, and the controller goes on from there.

## Limits

- **The max is a few times the memory at most.** Movable memory cannot hold the kernel's own
  allocations, such as page tables, slab and the page structures of plugged memory, so a guest that
  is mostly plugged memory runs out of kernel memory first. impd refuses a larger max at create.
- **The max is within the budget.** At a boot, the governor reserves room for the imp's memory, and
  at a wake for what the VM owned at its sleep, including the plugged memory it used
  ([sleep and wake](./sleep-and-wake.md#wake)). It refuses an imp whose max is larger than the whole
  budget, because a guest that could grow past the budget would make the governor sleep every other
  imp. The governor checks at each boot and wake, so a budget lowered later applies too.
- **The max is fixed.** A fork, a backup restore and a move keep it. A move refuses a target that
  cannot keep it, rather than land the imp at a fixed size.
- **An elastic imp never uses a boot template.** A template's snapshot has no hot-plug region, and a
  restore cannot add one, so an elastic imp always boots its kernel
  ([boot templates](./boot-templates.md)).

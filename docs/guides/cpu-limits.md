# CPU limits and resource use

Give an imp a CPU limit or a CPU weight with `impz new` or `impz set`, and check what each imp uses
with `impz ls` or `impz top`. impd samples each running imp's CPU, memory and network every 5 s and
also shows the result in the dashboard and the [telemetry](./events.md#telemetry). After you set a
limit, check that `impz info` does not show `limits OFF` (the note at the end of
[the memory limit](#the-memory-limit)).

## Limits and weights

```sh
impz new box --cpu-limit 1.5 --cpu-weight 200
impz set box --cpu-limit 0.5        # applies at once when box runs
impz set box --cpu-limit none       # no limit
impz set box --cpus 4               # vCPUs: only while box is stopped
impz set box --http-port 3000       # the port box's URL reaches, from the next request
```

| Setting        | Default             | Range                       | Meaning                                                            |
| -------------- | ------------------- | --------------------------- | ------------------------------------------------------------------ |
| `--cpu-limit`  | `none`              | 0.1 to the host's CPU count | The most CPU time the VM gets, in cores: `1.5` is one and a half.  |
| `--cpu-weight` | `100`               | 1 to 10000                  | The VM's share of the CPU when imps compete; idle time is free.    |
| `--cpus`       | `IMP_DEFAULT_VCPUS` | 1 to 32                     | The vCPUs the guest sees. A limit under the vCPU count slows each. |

A fork copies the source's limit and weight. A change to a sleeping imp applies at its next wake.
During a sleep or a wake, impd lifts the limit while Firecracker writes or loads the memory
snapshot, so a low limit never slows those steps. Memory has its own flags: `--memory` and
`--max-memory` ([elastic memory](../architecture/lifecycle/elastic-memory.md)).

## The memory limit

Each VM's cgroup also caps its memory a little over the guest's: 256 MiB more than `--memory`, or an
eighth more above 2 GiB, with no swap. A guest never reaches it on its own; a VM that leaks host
memory does. The kernel then kills the whole VM, and `impz ls --json` shows the stopped imp with the
error `its memory limit killed firecracker`. See [cgroups](../architecture/isolation.md#cgroups).

**NOTE:** impd enforces limits only when the host container runs in a private cgroup v2 namespace
(`--cgroupns=private`, which `scripts/dev/dev.sh` and `deploy/imp-host.service` pass) and
`setup-cgroups.sh` can remount its cgroupfs read-write. When either is missing, impd logs
`CPU limits are kept, not applied` and stores the settings. `impz info` then shows `limits OFF`, and
`impz info --json` shows `cpu.limitsEnforced: false`. No jailed VM can start then, so with the
jailer on, which is the default, no imp boots or wakes. With `IMP_JAILER=false`, VMs run as root,
unjailed and without limits ([isolation](../architecture/isolation.md#cgroups)).

## Resource use

`impz ls` has a `CPU` column: the last sample's use in percent of one core, over the limit when
there is one (`45% / 1.5`). `impz top` shows a table of every imp, busiest first, and refreshes it
as impd's events arrive and every 2 s. `impz top --once` prints it once, and `--json` prints the
imps with their `resources`.

| Column      | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `CPU`       | Use over the last 5 s sample, in percent of one core, over the limit.          |
| `WEIGHT`    | The CPU weight.                                                                |
| `THROTTLED` | Time the limit held the VM back since the last boot, wake or adopt.            |
| `RAM`       | Memory the VM owns, as the RAM governor counts it.                             |
| `DISK`      | What a destroy frees over the disk size, from impd's disk-usage pass.          |
| `NET IN`    | Bytes the guest received since the last boot, wake or adopt.                   |
| `NET OUT`   | Bytes the guest sent since the last boot, wake or adopt.                       |
| `WAKES`     | Wakes since the imp was created, counting a cold boot that stood in for one.   |
| `AWAKE`     | Total time the imp ran. A crash ends the span when impd last saw the VM alive. |

`THROTTLED`, `NET IN` and `NET OUT` count from `since` in `impz ls --json`: the end of the last boot
or wake, or the moment impd adopted a running VM after a restart. impd takes a baseline then,
because the tap outlives its VM and its counters still hold earlier boots' traffic. `WAKES` and
`AWAKE` live in the database and survive restarts.

The dashboard shows the CPU in the imp list, and on the imp's page a CPU panel with the sample, the
wakes, the time awake, and a form for the limit and the weight.

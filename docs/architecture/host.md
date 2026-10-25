# The host

impz runs almost entirely inside the imp-host container: impd, Firecracker, tailscaled and the
firewall for the imps' taps. The host under it is thin, and this doc is the contract it must meet,
so that any installer can meet it. Two installers exist: `deploy/bootstrap.sh` for Ubuntu and
Debian, and the NixOS module in impz's flake ([install](../guides/install.md),
[NixOS](../guides/nixos.md)). [Isolation](./isolation.md) covers what the container's boundary
holds.

## What the host gives

- **KVM** on x86_64, and cgroup v2.
- **Podman**, rootful, which runs the container.
- **Storage**: an XFS mount with reflink on the data directory, or a ZFS dataset impd's backend
  owns, with the modules each needs. The container's ZFS tools must share a major version with the
  host's module ([storage](./storage/storage.md#zfs)).
- **A ZFS module with the zfs_uiomove fix**: 2.3.7 or later on the 2.3 line, 2.4.2 or later on the
  2.4 line, or any later line. An older module can oops the kernel when a kill lands during a disk
  read, and the oops holds that imp's disk until a reboot
  ([minimum module versions](./storage/storage.md#zfs)). impd refuses to start on an older module,
  and its error includes the fixed versions and the override. `IMP_ZFS_ALLOW_UIOMOVE_BUG=1` starts
  it anyway, with a warning at start and in `/health`, for a host that cannot upgrade.
- **Memory settings**: overcommit on and little swapping, and on ZFS a capped ARC. The ARC sits
  outside impd's RAM budget, so the installers set the budget from the host's RAM less a share for
  the host and the ARC cap.
- **A firewall** that leaves the container engine's rules alone and never flushes the whole ruleset,
  since that removes the NAT the container's traffic leaves through.
- **An uplink** for the container's tailscaled, and nothing inbound.

Each installer writes the environment file, installs the seccomp profile from the image, and
installs the unit. The unit runs the image with the arguments in one file,
`deploy/imp-host.args.json`, from which the systemd unit and the bootstrap script are generated and
which the NixOS module reads, and a test fails when they drift apart. At each start, the unit probes
the host's global addresses for the egress deny list ([egress](./network/egress.md#public)) and the
devices and sysctls the host has. The tailnet node comes back from its saved state in the data
directory when it can, and joins with a key only when it has none.

## Privileges

The container runs without `--privileged`. Its arguments drop every capability and add back the few
impd uses: the mounts for storage, cgroups and the jailer; the network for taps, routes and the
firewall; device nodes for the jail; the uid switches for the jailer; and the file ownership and
capability writes that unpacking an image needs. Each one was kept because a run without it failed,
and the end-to-end harness fails when a dev instance's list differs. `/proc/sys` is read-only, so
the forwarding and tap sysctls come from the container's arguments and the scripts only check them.
AppArmor is unconfined, because the engine's default profile denies `mount`. The seccomp profile is
Docker's default, which Podman reads unchanged, with one rule added, `pivot_root`, which the jailer
needs.

**CAUTION:** the container is not a security boundary. With the mount capability in the host's user
namespace, root in the container can mount a new procfs and write `core_pattern`, and the host's
kernel runs that program as root. Treat code that gets root in the container as root on the host.
Dropping `--privileged` stops accidents: the container sees only its devices, loads no modules, and
cannot write the host's sysctls or cgroups by mistake. A real boundary needs the container to run
without the mount capability, which the jailer's mounts need.

The capability to write file capabilities, which images with `ping` or a privileged server need,
lets root in the container stamp any capability on a file it can write. The host keeps such files
inert, because the installers mount the data directory `nosuid`, which ignores setuid bits and file
capabilities alike, and an image is unpacked in a directory no host user can reach.

## The Docker socket

imp-host gets no Docker or Podman socket and ships no client for either. impd fetches the builder
image that every build and pull runs in from its registry
([images](./storage/images.md#where-builds-run)), so no process in the container calls the host's
engine, which only starts and stops imp-host. A missing socket closes one path out of the container
only: the mount capability above is still a way out.

## The host firewall

The host needs no inbound port for imp. impd's ports are published on the host's loopback only, the
tailnet reaches impd inside the container, and impd's own tables live in the container's namespace,
where the host's firewall never sees them. The owner chooses who owns the host's inbound firewall:
impz's own table, an input chain that drops all but SSH, ICMP and DHCP, or the platform's firewall,
such as NixOS's. In nftables a drop in any base chain wins, so impz's table blocks whatever another
firewall allows, and the NixOS module refuses it beside the platform's. A firewall that filters
forwarding must admit the container's bridge, or the imps' traffic never leaves.

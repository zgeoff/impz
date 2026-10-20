// The file that holds an imp's disk in the dev container. It is a file on
// both backends: disk.ext4 on XFS, and on ZFS the one file in the imp's
// mounted disk dataset (packages/daemon/src/vm/storage/data-layout.ts).
export function buildImpDiskPath(backend: 'xfs' | 'zfs', impId: string): string {
  const directory = `/var/lib/imp/imps/${impId}`;

  return backend === 'zfs' ? `${directory}/disk/rootfs.ext4` : `${directory}/disk.ext4`;
}

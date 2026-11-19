export function buildImpDiskPath(backend: 'xfs' | 'zfs', impId: string): string {
  const directory = `/var/lib/imp/imps/${impId}`;

  return backend === 'zfs' ? `${directory}/disk/rootfs.ext4` : `${directory}/disk.ext4`;
}

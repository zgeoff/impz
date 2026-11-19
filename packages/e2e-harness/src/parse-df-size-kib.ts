export function parseDfSizeKib(stdout: string): number {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  const sizeKib = Number(last.split(/\s+/u)[1]);

  if (!Number.isInteger(sizeKib)) {
    throw new TypeError(`no size in df output: ${JSON.stringify(stdout)}`);
  }

  return sizeKib;
}

export function buildImpDiskPath(backend: 'xfs' | 'zfs', id: string): string {
  return backend === 'xfs'
    ? `/var/lib/imp/imps/${id}/disk.ext4`
    : `/var/lib/imp/imps/${id}/disk/rootfs.ext4`;
}

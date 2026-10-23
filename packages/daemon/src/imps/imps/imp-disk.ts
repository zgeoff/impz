import { statSync, truncateSync } from 'node:fs';
import { formatBytes } from '@impz/shared';
import { ImpdError } from '../../platform/errors/impd-error';
import { runChecked } from '../../platform/process/run-command';

export const MIB = 1024 * 1024;

export function growDiskFile(disk: string, diskBytes: number): number {
  const size = statSync(disk).size;

  // The guest's ext4 cannot shrink online, and a smaller file would cut it off.
  if (diskBytes > size) {
    truncateSync(disk, diskBytes);

    return diskBytes;
  }

  return size;
}

export async function growFilesystem(disk: string): Promise<boolean> {
  const header = await runChecked(['dumpe2fs', '-h', disk]);

  const state = /^Filesystem state:\s+(?<state>.+)$/mu.exec(header)?.groups?.['state']?.trim();
  const features = /^Filesystem features:\s+(?<features>.+)$/mu.exec(header)?.groups?.['features'];

  if (state !== 'clean' || features === undefined || features.includes('needs_recovery')) {
    return false;
  }

  await runChecked(['resize2fs', '-f', disk]);

  return true;
}

export function readFileBytes(path: string): number {
  return statSync(path).size;
}

export function buildDiskTooSmallError(diskBytes: number, floorBytes: number, why: string) {
  return new ImpdError('BAD_REQUEST', {
    message: `a disk of ${formatBytes(diskBytes)} is smaller than ${why} (${formatBytes(floorBytes)})`,
  });
}

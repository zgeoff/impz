import { mkdirSync, writeFileSync } from 'node:fs';
import { writeSnapshotMeta } from '../../src/vm/sleep/snapshot-meta';
import type { SnapshotIdentity } from '../../src/vm/sleep/snapshot-meta';
import type { ImpPaths } from '../../src/vm/storage/data-layout';

// A memory snapshot as a sleep at `createdAt` by a VM with `identity` leaves
// it, recording the 300 MiB each of startTestImpd's fake VMs holds
export function writeTestSnapshot(
  paths: Readonly<ImpPaths>,
  createdAt: number,
  identity: Readonly<SnapshotIdentity>,
): void {
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.vmstate, 'vmstate');
  writeFileSync(paths.memFile, 'mem');

  writeSnapshotMeta(paths, {
    ...identity,
    createdAt,
    memoryMib: 2048,
    ramMib: 300,
  });
}

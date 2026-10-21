import { mkdirSync, writeFileSync } from 'node:fs';
import { writeSnapshotMeta } from '../../src/vm/sleep/snapshot-meta';
import type { SnapshotIdentity } from '../../src/vm/sleep/snapshot-meta';
import type { ImpPaths } from '../../src/vm/storage/data-layout';

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

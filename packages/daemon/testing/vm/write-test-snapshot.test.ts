import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSnapshot, readSnapshotMeta } from '../../src/sleep/snapshot-meta';
import { buildImpPaths } from '../../src/storage/data-layout';
import { writeTestSnapshot } from './write-test-snapshot';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'write-test-snapshot-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  return { dataDir };
}

test('it writes the files and the meta a wake loads', async () => {
  const ctx = await setupTest();

  const paths = buildImpPaths(ctx.dataDir, 'imp-a');

  writeTestSnapshot(paths, 1234, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
  });

  expect(probeSnapshot(paths)).toBeTrue();

  expect(readSnapshotMeta(paths)).toStrictEqual({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
    createdAt: 1234,
    memoryMib: 2048,
    ramMib: 300,
  });
});

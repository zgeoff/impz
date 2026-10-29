import { expect, test } from 'bun:test';
import { BackupManifestSchema } from './backup-manifest';

test('it reads an imp from a manifest written before cloned digests with no cloned digest', () => {
  const result = BackupManifestSchema.safeParse({
    version: 1,
    runId: 'run-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    imps: [
      {
        id: 'imp-1',
        name: 'dev',
        imageDigest: 'sha256:base',
        vcpus: 1,
        memoryMib: 512,
        httpPort: 8080,
        state: 'stopped',
        synced: true,
        // oxlint-disable-next-line zgeoff/no-abbreviated-names -- a key of the manifest that backups store
        dir: 'imps/imp-1',
        disk: 'imps/imp-1/disk.ext4',
        checkpoints: [],
      },
    ],
    images: [],
  });

  expect(result.data?.imps[0]?.clonedDigest).toBeUndefined();
  expect(result.data?.imps[0]?.imageDigest).toBe('sha256:base');
});

test('it reads the cloned digest a manifest records for an imp', () => {
  const result = BackupManifestSchema.safeParse({
    version: 1,
    runId: 'run-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    imps: [
      {
        id: 'imp-1',
        name: 'dev',
        imageDigest: 'sha256:base',
        clonedDigest: 'sha256:older',
        vcpus: 1,
        memoryMib: 512,
        httpPort: 8080,
        state: 'stopped',
        synced: true,
        // oxlint-disable-next-line zgeoff/no-abbreviated-names -- a key of the manifest that backups store
        dir: 'imps/imp-1',
        disk: 'imps/imp-1/disk.ext4',
        checkpoints: [],
      },
    ],
    images: [],
  });

  expect(result.data?.imps[0]?.clonedDigest).toBe('sha256:older');
});

test('it drops an imp field it does not know, as a manifest from a newer impd holds', () => {
  const result = BackupManifestSchema.safeParse({
    version: 1,
    runId: 'run-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    imps: [
      {
        id: 'imp-1',
        name: 'dev',
        imageDigest: 'sha256:base',
        laterField: 'sha256:older',
        vcpus: 1,
        memoryMib: 512,
        httpPort: 8080,
        state: 'stopped',
        synced: true,
        // oxlint-disable-next-line zgeoff/no-abbreviated-names -- a key of the manifest that backups store
        dir: 'imps/imp-1',
        disk: 'imps/imp-1/disk.ext4',
        checkpoints: [],
      },
    ],
    images: [],
  });

  expect(result.success).toBeTrue();
  expect(result.data?.imps[0]).not.toContainKey('laterField');
});

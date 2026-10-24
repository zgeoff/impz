import { existsSync, writeFileSync } from 'node:fs';
import type { StorageBackend } from '../../src/vm/storage/storage-backend';
import { createZfsBackend } from '../../src/vm/storage/zfs/zfs-backend';
import { buildStubZfs } from './build-stub-zfs';
import type { StubZfs } from './build-stub-zfs';

export function buildStubZfsStorage(
  root: string,

  options: Readonly<{ moduleVersion?: string; isUiomoveBugAllowed?: boolean }> = {},
) {
  const moduleVersion = options.moduleVersion ?? '2.4.4';
  const made: { pool: StubZfs | null } = { pool: null };

  const createStorage = (dataDir: string): StorageBackend => {
    const zfs = buildStubZfs({ root, rootDir: dataDir });

    made.pool = zfs;

    const backend = createZfsBackend({
      dataDir,
      root,
      run: zfs.run,
      streams: zfs.streams,
      readMounts: zfs.readMounts,
      readModuleVersion: () => moduleVersion,
      isUiomoveBugAllowed: options.isUiomoveBugAllowed === true,
    });

    const writeDisk = (impId: string) => {
      const disk = backend.resolveImpPaths(impId).disk;

      if (!existsSync(disk)) {
        writeFileSync(disk, 'disk');
      }
    };

    return {
      ...backend,
      createImpDisk: async (impId, source) => {
        await backend.createImpDisk(impId, source);

        writeDisk(impId);
      },
      receiveMoveSnapshots: async (impId, steps, readStep, buildId) => {
        const received = await backend.receiveMoveSnapshots(impId, steps, readStep, buildId);

        writeDisk(impId);

        return received;
      },
    };
  };

  const readPool = (): StubZfs => {
    if (made.pool === null) {
      throw new Error('no pool: the storage was never made');
    }

    return made.pool;
  };

  return { createStorage, readPool };
}

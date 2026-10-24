import type { MoveSource, StorageBackend } from '../../src/vm/storage/storage-backend';

type FaultMethod = 'openMoveSource' | 'closeMoveSource';

export function buildStubStorageFaults() {
  const pending: Record<FaultMethod, Error | null> = {
    openMoveSource: null,
    closeMoveSource: null,
  };

  const closeSource = async (source: MoveSource): Promise<void> => {
    const error = pending.closeMoveSource;

    await source.close();

    if (error !== null) {
      pending.closeMoveSource = null;
      throw error;
    }
  };

  return {
    wrap: (backend: StorageBackend): StorageBackend => ({
      ...backend,
      openMoveSource: async (impId, checkpointIds, mode) => {
        const error = pending.openMoveSource;

        if (error !== null) {
          pending.openMoveSource = null;
          throw error;
        }

        const source = await backend.openMoveSource(impId, checkpointIds, mode);

        return { ...source, close: () => closeSource(source) };
      },
    }),
    failOnce: (method: FaultMethod, error: Error) => {
      pending[method] = error;
    },
  };
}

import type { StorageBackend } from '../../src/vm/storage/storage-backend';

export function buildStubStorageFaults() {
  const pending: { openMoveSource: Error | null } = { openMoveSource: null };

  return {
    wrap: (backend: StorageBackend): StorageBackend => ({
      ...backend,
      openMoveSource: (impId, checkpointIds, mode) => {
        const error = pending.openMoveSource;

        if (error === null) {
          return backend.openMoveSource(impId, checkpointIds, mode);
        }

        pending.openMoveSource = null;

        return Promise.reject(error);
      },
    }),
    failOnce: (method: 'openMoveSource', error: Error) => {
      pending[method] = error;
    },
  };
}

import type { StorageBackend } from '../../src/vm/storage/storage-backend';

interface StoragePressure {
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly freedBytes: number;
}

// Stands in for a full pool, on which every image frees the same bytes and no clone shares one.
export function buildStubStoragePressure(
  pressure: Readonly<StoragePressure>,
): Pick<StorageBackend, 'readUsage' | 'measureImages'> {
  return {
    readUsage: () =>
      Promise.resolve({ usedBytes: pressure.usedBytes, availableBytes: pressure.availableBytes }),
    measureImages: (digests) =>
      Promise.resolve({
        images: new Map(
          digests.map((digest) => [digest, { freedBytes: pressure.freedBytes, isShared: false }]),
        ),
        freeingBytes: 0,
      }),
  };
}

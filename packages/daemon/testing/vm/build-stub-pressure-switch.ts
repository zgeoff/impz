import type { StorageBackend } from '../../src/vm/storage/storage-backend';
import { buildStubStoragePressure } from './build-stub-storage-pressure';

type PressuredStorage = Pick<StorageBackend, 'readUsage' | 'measureImages'>;

type StoragePressure = Parameters<typeof buildStubStoragePressure>[0];

export function buildStubPressureSwitch() {
  const state: { stub: PressuredStorage | null } = { stub: null };

  return {
    wrap: <T extends PressuredStorage>(
      storage: T,
    ): Omit<T, keyof PressuredStorage> & PressuredStorage => ({
      ...storage,
      readUsage: () => (state.stub ?? storage).readUsage(),
      measureImages: (digests: readonly string[]) => (state.stub ?? storage).measureImages(digests),
    }),
    setPressure: (pressure: StoragePressure): void => {
      state.stub = buildStubStoragePressure(pressure);
    },
  };
}

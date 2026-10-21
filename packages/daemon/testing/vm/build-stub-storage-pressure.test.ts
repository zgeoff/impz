import { expect, test } from 'bun:test';
import { buildStubStoragePressure } from './build-stub-storage-pressure';

test('it reads the usage it was given', async () => {
  const storage = buildStubStoragePressure({ usedBytes: 90, availableBytes: 10, freedBytes: 5 });

  const usage = await storage.readUsage();

  expect(usage).toStrictEqual({ usedBytes: 90, availableBytes: 10 });
});

test('it measures every image it is asked about as unshared and freeing the bytes it was given', async () => {
  const storage = buildStubStoragePressure({ usedBytes: 90, availableBytes: 10, freedBytes: 5 });

  const report = await storage.measureImages(['sha256:1', 'sha256:2']);

  expect(report).toStrictEqual({
    images: new Map([
      ['sha256:1', { freedBytes: 5, isShared: false }],
      ['sha256:2', { freedBytes: 5, isShared: false }],
    ]),
    freeingBytes: 0,
  });
});

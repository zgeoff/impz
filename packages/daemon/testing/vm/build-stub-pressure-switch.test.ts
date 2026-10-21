import { expect, mock, test } from 'bun:test';
import { buildStubPressureSwitch } from './build-stub-pressure-switch';

test('it answers with the wrapped storage until a pressure is set', async () => {
  const pressure = buildStubPressureSwitch();

  const storage = pressure.wrap({
    readUsage: () => Promise.resolve({ usedBytes: 10, availableBytes: 90 }),
    measureImages: () => Promise.resolve({ images: new Map(), freeingBytes: 7 }),
  });

  const usage = await storage.readUsage();
  const report = await storage.measureImages(['sha256:1']);

  expect(usage).toStrictEqual({ usedBytes: 10, availableBytes: 90 });
  expect(report).toStrictEqual({ images: new Map(), freeingBytes: 7 });
});

test('it answers with the pressure once a test sets one', async () => {
  const pressure = buildStubPressureSwitch();

  const storage = pressure.wrap({
    readUsage: () => Promise.resolve({ usedBytes: 10, availableBytes: 90 }),
    measureImages: () => Promise.resolve({ images: new Map(), freeingBytes: 7 }),
  });

  pressure.setPressure({ usedBytes: 90, availableBytes: 10, freedBytes: 5 });

  const usage = await storage.readUsage();
  const report = await storage.measureImages(['sha256:1']);

  expect(usage).toStrictEqual({ usedBytes: 90, availableBytes: 10 });

  expect(report).toStrictEqual({
    images: new Map([['sha256:1', { freedBytes: 5, isShared: false }]]),
    freeingBytes: 0,
  });
});

test('it keeps the other members of the wrapped storage', () => {
  const pressure = buildStubPressureSwitch();
  const removeImage = mock(() => Promise.resolve());

  const storage = pressure.wrap({
    readUsage: () => Promise.resolve({ usedBytes: 10, availableBytes: 90 }),
    measureImages: () => Promise.resolve({ images: new Map(), freeingBytes: 0 }),
    removeImage,
  });

  expect(storage.removeImage).toBe(removeImage);
});

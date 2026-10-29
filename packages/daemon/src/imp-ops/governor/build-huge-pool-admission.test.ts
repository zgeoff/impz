import { expect, test } from 'bun:test';
import { buildHugePoolAdmission } from './build-huge-pool-admission';

test('it admits a guest whose memory fits the free pool', () => {
  expect(
    buildHugePoolAdmission({
      pool: { totalMib: 1024, freeMib: 512 },
      awake: [],
      pendingMib: [],
      requestedMib: 512,
    }),
  ).toStrictEqual({ admitted: true });
});

test('it refuses a guest one block larger than the free pool', () => {
  expect(
    buildHugePoolAdmission({
      pool: { totalMib: 1024, freeMib: 512 },
      awake: [],
      pendingMib: [],
      requestedMib: 514,
    }),
  ).toStrictEqual({ admitted: false, totalMib: 1024, committedMib: 512, neededMib: 2 });
});

test('it counts the memory an awake guest has not touched yet as promised', () => {
  expect(
    buildHugePoolAdmission({
      pool: { totalMib: 1024, freeMib: 768 },
      awake: [{ hugePagesMib: 512, heldMib: 256 }],
      pendingMib: [],
      requestedMib: 514,
    }),
  ).toStrictEqual({ admitted: false, totalMib: 1024, committedMib: 512, neededMib: 2 });
});

test('it counts no growth for an awake guest that holds all its memory', () => {
  expect(
    buildHugePoolAdmission({
      pool: { totalMib: 1024, freeMib: 512 },
      awake: [{ hugePagesMib: 512, heldMib: 512 }],
      pendingMib: [],
      requestedMib: 512,
    }),
  ).toStrictEqual({ admitted: true });
});

test('it counts the memory of each admission still under way as promised', () => {
  expect(
    buildHugePoolAdmission({
      pool: { totalMib: 1024, freeMib: 1024 },
      awake: [],
      pendingMib: [256, 512],
      requestedMib: 512,
    }),
  ).toStrictEqual({ admitted: false, totalMib: 1024, committedMib: 768, neededMib: 256 });
});

test('it refuses every guest when the host has no pool', () => {
  expect(
    buildHugePoolAdmission({ pool: null, awake: [], pendingMib: [], requestedMib: 2 }),
  ).toStrictEqual({ admitted: false, totalMib: 0, committedMib: 0, neededMib: 2 });
});

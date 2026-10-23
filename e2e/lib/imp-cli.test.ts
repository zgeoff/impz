import { expect, test } from 'bun:test';
import { parseImp, parseSystemInfo } from './imp-cli';

test('#parseImp reads an imp as impz --json prints it, with its dates as ISO strings', () => {
  const stdout = JSON.stringify({
    id: 'imp_01hzy3k8',
    name: 'web',
    image: 'base',
    state: 'sleeping',
    vcpus: 2,
    memoryMib: 1024,
    slot: 3,
    ip: '10.100.0.13',
    port: 22_003,
    url: 'http://web.imp.localhost:8080',
    lastActiveAt: '2026-10-01T09:00:00.000Z',
    sleptAt: '2026-10-01T09:05:00.000Z',
    diskUsage: {
      exclusiveBytes: 4096,
      sharedBytes: 8192,
      measuredAt: '2026-10-01T09:04:00.000Z',
      isPartial: false,
      isUpperBound: false,
    },
    resources: { wakeCount: 4, awakeMs: 90_000, sample: { cpuThrottledMs: 12 } },
    createdAt: '2026-09-30T08:00:00.000Z',
  });

  expect(parseImp(stdout)).toStrictEqual({
    id: 'imp_01hzy3k8',
    name: 'web',
    image: 'base',
    state: 'sleeping',
    vcpus: 2,
    memoryMib: 1024,
    slot: 3,
    ip: '10.100.0.13',
    port: 22_003,
    url: 'http://web.imp.localhost:8080',
    lastActiveAt: '2026-10-01T09:00:00.000Z',
    sleptAt: '2026-10-01T09:05:00.000Z',
    diskUsage: {
      exclusiveBytes: 4096,
      sharedBytes: 8192,
      measuredAt: new Date('2026-10-01T09:04:00.000Z'),
      isPartial: false,
      isUpperBound: false,
    },
    resources: { wakeCount: 4, awakeMs: 90_000, sample: { cpuThrottledMs: 12 } },
  });
});

test('#parseImp refuses an address that is not IPv4, naming the ip field', () => {
  const stdout = JSON.stringify({
    id: 'imp_01hzy3k8',
    name: 'web',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    slot: 3,
    ip: 'not-an-address',
    port: 22_003,
    url: 'http://web.imp.localhost:8080',
    lastActiveAt: '2026-10-01T09:00:00.000Z',
  });

  expect(() => parseImp(stdout)).toThrow(
    expect.objectContaining({ issues: [expect.objectContaining({ path: ['ip'] })] }),
  );
});

test('#parseSystemInfo reads the system info as impz info --json prints it', () => {
  const stdout = JSON.stringify({
    version: '0.42.0',
    ramBudgetMib: 4096,
    ramUsedMib: 1536,
    ramReservedMib: 512,
    awakeCount: 2,
    impCount: 5,
    storage: {
      backend: 'zfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 2_000_000,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
  });

  expect(parseSystemInfo(stdout)).toStrictEqual({
    ramBudgetMib: 4096,
    ramUsedMib: 1536,
    ramReservedMib: 512,
    awakeCount: 2,
    impCount: 5,
    storage: {
      backend: 'zfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 2_000_000,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
  });
});

test('#parseSystemInfo refuses a negative RAM budget, naming the ramBudgetMib field', () => {
  const stdout = JSON.stringify({
    ramBudgetMib: -1,
    ramUsedMib: 1536,
    ramReservedMib: 512,
    awakeCount: 2,
    impCount: 5,
    storage: {
      backend: 'zfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 2_000_000,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
  });

  expect(() => parseSystemInfo(stdout)).toThrow(
    expect.objectContaining({ issues: [expect.objectContaining({ path: ['ramBudgetMib'] })] }),
  );
});

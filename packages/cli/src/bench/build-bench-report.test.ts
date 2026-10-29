import { expect, test } from 'bun:test';
import { buildBenchReport } from './build-bench-report';

test('it names the host from impd before the run, and the state on both sides of it', () => {
  const info = {
    version: '6.2.0',
    ramBudgetMib: 12_288,
    ramUsedMib: 0,
    ramReservedMib: 0,
    ramCommittedMib: 0,
    awakeCount: 0,
    impCount: 1,
    sessionCount: 0,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    firecrackerVersion: '1.17.0',
    guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
    systemDrive: { sha256: 'b'.repeat(64) },
    storage: {
      backend: 'xfs' as const,
      usedBytes: 0,
      availableBytes: 0,
      reserveBytes: 0,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 0,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    cpu: { hostCpus: 4, limitsEnforced: true },
    host: {
      kernel: '6.8.0',
      cpuModel: 'AMD EPYC 7763 64-Core Processor',
      isNested: true,
      hugePages: '2M' as const,
      hugePool: { totalMib: 1024, freeMib: 1024 },
      bootTemplates: 0,
    },
  };

  const after = {
    ...info,
    awakeCount: 1,
    host: { ...info.host, hugePool: { totalMib: 1024, freeMib: 768 }, bootTemplates: 1 },
  };

  const report = buildBenchReport({
    runID: 'a1b2',
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    label: null,
    before: info,
    after,
    settings: { memoryMib: null, image: null, awakeMs: 0, levels: [1], samples: 1 },
    results: [],
  });

  expect(report).toStrictEqual({
    runID: 'a1b2',
    startedAt: '2026-01-02T03:04:05.000Z',
    host: {
      label: null,
      impdVersion: '6.2.0',
      kernel: '6.8.0',
      cpuModel: 'AMD EPYC 7763 64-Core Processor',
      cpus: 4,
      isNested: true,
      ramBudgetMib: 12_288,
      storage: 'xfs',
      firecracker: '1.17.0',
      guestKernel: '6.1.188',
      isKsmRunning: false,
      hugePages: '2M',
    },
    before: { bootTemplates: 0, hugePoolFreeMib: 1024, awakeCount: 0, impCount: 1 },
    after: { bootTemplates: 1, hugePoolFreeMib: 768, awakeCount: 1, impCount: 1 },
    settings: { memoryMib: null, image: null, awakeMs: 0, levels: [1], samples: 1 },
    results: [],
  });
});

test('it reads an impd from before the host facts as a host it cannot name', () => {
  const info = {
    version: '6.1.1',
    ramBudgetMib: 4096,
    ramUsedMib: 0,
    ramReservedMib: 0,
    ramCommittedMib: 0,
    awakeCount: 0,
    impCount: 0,
    sessionCount: 0,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    firecrackerVersion: null,
    guestKernel: { version: null, sha256: 'a'.repeat(64) },
    systemDrive: { sha256: 'b'.repeat(64) },
    storage: {
      backend: 'zfs' as const,
      usedBytes: 0,
      availableBytes: 0,
      reserveBytes: 0,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 0,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
  };

  const report = buildBenchReport({
    runID: 'c3d4',
    startedAt: new Date('2026-01-02T03:04:05.000Z'),
    label: 'old-box',
    before: info,
    after: info,
    settings: { memoryMib: null, image: null, awakeMs: 0, levels: [1], samples: 1 },
    results: [],
  });

  expect(report.host).toMatchObject({
    kernel: null,
    cpuModel: null,
    cpus: null,
    isNested: null,
    hugePages: null,
  });
});

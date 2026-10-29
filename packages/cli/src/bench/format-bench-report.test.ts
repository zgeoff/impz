import { expect, test } from 'bun:test';
import { formatBenchReport } from './format-bench-report';

test('it lays out the host, its state and one row per scenario and concurrency', () => {
  const report = {
    runID: 'a1b2',
    startedAt: '2026-01-02T03:04:05.000Z',
    host: {
      label: 'rack-7',
      impdVersion: '6.2.0',
      kernel: '6.8.0-1017-azure',
      cpuModel: 'AMD EPYC 7763 64-Core Processor',
      cpus: 4,
      isNested: true,
      ramBudgetMib: 12_288,
      storage: 'xfs' as const,
      firecracker: '1.17.0',
      guestKernel: '6.1.188',
      isKsmRunning: false,
      hugePages: '2M' as const,
    },
    before: { bootTemplates: 0, hugePoolFreeMib: 1024, awakeCount: 0, impCount: 0 },
    after: { bootTemplates: 2, hugePoolFreeMib: 1024, awakeCount: 0, impCount: 0 },
    settings: { memoryMib: 256, image: null, awakeMs: 0, levels: [1, 64], samples: 20 },
    results: [
      {
        scenario: 'sleep',
        concurrency: 1,
        samples: 20,
        failures: {},
        latencyMs: { p50: 412, p95: 530, p99: 601, max: 601 },
        impdMs: { p50: 380, p95: 500, p99: 570, max: 570 },
        memFileMib: { p50: 74, p95: 76, p99: 76, max: 76 },
      },
      {
        scenario: 'sleep',
        concurrency: 64,
        samples: 50,
        failures: { RAM_BUDGET_EXCEEDED: 14 },
        latencyMs: { p50: 2210, p95: 4980, p99: 5120, max: 5120 },
        impdMs: null,
        memFileMib: null,
      },
    ],
  };

  expect(formatBenchReport(report)).toMatchInlineSnapshot(`
    "host: rack-7, AMD EPYC 7763 64-Core Processor, 4 cpus, kernel 6.8.0-1017-azure, nested, huge pages 2M, storage xfs, impd 6.2.0
    before: 0 boot templates, 1024 MiB pool free, 0 of 0 imps awake
    after: 2 boot templates, 1024 MiB pool free, 0 of 0 imps awake

    scenario  conc  samples  failed                  p50     p95     p99     impd p50  mem file
    sleep     1     20       0                       412ms   530ms   601ms   380ms     74 MiB
    sleep     64    50       14 RAM_BUDGET_EXCEEDED  2210ms  4980ms  5120ms  -         -"
  `);
});

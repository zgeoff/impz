import { expect, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { formatCpuUse } from './format-cpu-use';

test('#formatCpuUse shows the last sample', () => {
  const imp = buildMockImp({
    cpu: { limit: null },
    resources: {
      sample: {
        measuredAt: new Date(0),
        since: new Date(0),
        cpuPercent: 2,
        cpuThrottledMs: 0,
        netRxBytes: 0,
        netTxBytes: 0,
      },
    },
  });

  expect(formatCpuUse(imp)).toBe('2%');
});

test('#formatCpuUse shows the last sample over the limit', () => {
  const imp = buildMockImp({
    cpu: { limit: 1.5 },
    resources: {
      sample: {
        measuredAt: new Date(0),
        since: new Date(0),
        cpuPercent: 2,
        cpuThrottledMs: 0,
        netRxBytes: 0,
        netTxBytes: 0,
      },
    },
  });

  expect(formatCpuUse(imp)).toBe('2% / 1.5');
});

test('#formatCpuUse shows - for an imp with no sample', () => {
  const imp = buildMockImp({ state: 'sleeping', cpu: { limit: null } });

  expect(formatCpuUse(imp)).toBe('-');
});

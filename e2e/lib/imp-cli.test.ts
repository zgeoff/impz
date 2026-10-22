import { expect, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { buildMockSystemInfo } from '@impz/api/test-utils/build-mock-system-info';
import { parseImp, parseSystemInfo } from './imp-cli';

test('#parseImp reads an imp as impz --json prints it, with its dates as ISO strings', () => {
  const imp = buildMockImp({
    name: 'web',
    state: 'sleeping',
    lastActiveAt: new Date('2026-10-01T09:00:00.000Z'),
    sleptAt: new Date('2026-10-01T09:05:00.000Z'),
    diskUsage: {
      exclusiveBytes: 4096,
      sharedBytes: 8192,
      measuredAt: new Date('2026-10-01T09:04:00.000Z'),
      isPartial: false,
      isUpperBound: false,
    },
  });

  const row = parseImp(JSON.stringify(imp, null, 2));

  expect(row).toMatchObject({
    name: 'web',
    state: 'sleeping',
    lastActiveAt: '2026-10-01T09:00:00.000Z',
    sleptAt: '2026-10-01T09:05:00.000Z',
    diskUsage: {
      exclusiveBytes: 4096,
      sharedBytes: 8192,
      measuredAt: new Date('2026-10-01T09:04:00.000Z'),
      isPartial: false,
      isUpperBound: false,
    },
  });
});

test('#parseImp refuses a state the API does not have', () => {
  const imp = { ...buildMockImp(), state: 'paused' };

  expect(() => parseImp(JSON.stringify(imp))).toThrow();
});

test('#parseSystemInfo reads the system info as impz info --json prints it', () => {
  const info = buildMockSystemInfo({ ramBudgetMib: 4096, storage: { backend: 'zfs' } });
  const parsed = parseSystemInfo(JSON.stringify(info, null, 2));

  expect(parsed.ramBudgetMib).toBe(4096);
  expect(parsed.storage.backend).toBe('zfs');
});

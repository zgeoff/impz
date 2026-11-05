import { expect, test } from 'bun:test';
import { formatHeldLock } from './format-held-lock';

test('it names the process that holds the lock', () => {
  expect(
    formatHeldLock({
      path: '/run/impz-dev-imp-bench.lock',
      name: 'imp-bench',
      holder: { pid: 4242 },
    }),
  ).toBe('process 4242 holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)');
});

test('it names no process for a lock whose holder has not yet written its record', () => {
  expect(
    formatHeldLock({ path: '/run/impz-dev-imp-bench.lock', name: 'imp-bench', holder: null }),
  ).toBe('another process holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)');
});

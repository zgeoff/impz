import { expect, test } from 'bun:test';
import { formatHeldLock } from './format-held-lock';

test('it names the live process that holds the lock', () => {
  expect(
    formatHeldLock({
      path: '/run/impz-dev-imp-bench.lock',
      name: 'imp-bench',
      holder: { pid: 4242, isAlive: true },
    }),
  ).toBe('process 4242 holds the dev instance imp-bench (/run/impz-dev-imp-bench.lock)');
});

test('it names the lock file an exited process left, for removal', () => {
  expect(
    formatHeldLock({
      path: '/run/impz-dev-imp-bench.lock',
      name: 'imp-bench',
      holder: { pid: 4242, isAlive: false },
    }),
  ).toBe(
    'process 4242 has exited but left the lock on the dev instance imp-bench; remove /run/impz-dev-imp-bench.lock once no bench runs',
  );
});

test('it names the lock file of a lock that names no process, for removal', () => {
  expect(
    formatHeldLock({ path: '/run/impz-dev-imp-bench.lock', name: 'imp-bench', holder: null }),
  ).toBe(
    'the lock on the dev instance imp-bench names no process; remove /run/impz-dev-imp-bench.lock once no bench runs',
  );
});

import { expect, test } from 'bun:test';
import { defineReconciler } from './define-reconciler';

test('it returns the reconciler as defined', () => {
  const idle = defineReconciler({
    name: 'idle',
    intervalMs: 2000,
    reconcile: () => Promise.resolve({ outcome: 'unchanged', summary: 'quiet' }),
  });

  expect(idle).toStrictEqual({ name: 'idle', intervalMs: 2000, reconcile: expect.any(Function) });
});

test.each([0, -1, 1.5])('it refuses an interval of %p ms', (intervalMs) => {
  const define = () =>
    defineReconciler({
      name: 'idle',
      intervalMs,
      reconcile: () => Promise.resolve({ outcome: 'unchanged', summary: 'quiet' }),
    });

  expect(define).toThrowWithMessage(Error, /needs a whole interval above 0 ms/u);
});

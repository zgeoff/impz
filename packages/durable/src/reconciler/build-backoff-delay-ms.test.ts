import { expect, test } from 'bun:test';
import { buildBackoffDelayMs } from './build-backoff-delay-ms';

test('it waits one interval after a pass with no error', () => {
  const delayMs = buildBackoffDelayMs(2000, 0, 0.7);

  expect(delayMs).toBe(2000);
});

test.each([
  { consecutiveErrors: 1, expectedMs: 4000 },
  { consecutiveErrors: 2, expectedMs: 8000 },
  { consecutiveErrors: 3, expectedMs: 16_000 },
  { consecutiveErrors: 4, expectedMs: 20_000 },
  { consecutiveErrors: 9, expectedMs: 20_000 },
])(
  'it waits at most $expectedMs ms on a 2000 ms interval after $consecutiveErrors errors',
  (row) => {
    const delayMs = buildBackoffDelayMs(2000, row.consecutiveErrors, 1);

    expect(delayMs).toBe(row.expectedMs);
  },
);

test('it waits half the backoff for the lowest draw', () => {
  const delayMs = buildBackoffDelayMs(2000, 2, 0);

  expect(delayMs).toBe(4000);
});

test('it spreads the delay between half and all of the backoff', () => {
  const delayMs = buildBackoffDelayMs(2000, 1, 0.5);

  expect(delayMs).toBe(3000);
});

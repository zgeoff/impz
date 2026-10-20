import { expect, test } from 'bun:test';
import { waitForOutcome } from './wait-for-outcome';

test('#waitForOutcome reports done for a promise that resolves', async () => {
  const outcome = await waitForOutcome(Promise.resolve('fine'), 1000);

  expect(outcome).toBe('done');
});

test('#waitForOutcome reports failed for a promise that rejects', async () => {
  const outcome = await waitForOutcome(Promise.reject(new Error('boom')), 1000);

  expect(outcome).toBe('failed');
});

test('#waitForOutcome reports hung for a promise still pending at its deadline', async () => {
  const clock = { nowMs: 0 };

  const outcome = await waitForOutcome(new Promise(() => {}), 1000, {
    now: () => clock.nowMs,
    wait: (durationMs) => {
      clock.nowMs += durationMs;

      return Promise.resolve();
    },
  });

  expect(outcome).toBe('hung');
});

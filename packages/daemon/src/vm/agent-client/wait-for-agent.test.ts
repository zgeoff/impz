import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitWithClock } from '@impz/shared/test-utils/await-with-clock';
import { createFakeClock } from '@zgeoff/testing/clock';
import { startStubParkedAgent } from '../../test-utils/vm/start-stub-parked-agent';
import { waitForAgent } from './wait-for-agent';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-wait-agent-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { vsockPath: join(directory, 'vsock.sock'), clock: createFakeClock() };
}

test('it gives up at the deadline of the injected clock, doubling each wait up to its cap', async () => {
  const ctx = setupTest();
  const waiting = waitForAgent(ctx.vsockPath, { deadlineMs: 300, clock: ctx.clock });

  const error = await awaitWithClock(ctx.clock, waiting).catch((error_: unknown) => error_);

  expect(String(error)).toMatch(/^Error: agent did not answer within 300 ms \(last error: /u);
  expect(ctx.clock.delays).toStrictEqual([5, 10, 20, 40, 80, 100, 100]);
});

test('it returns the ping of an agent parked in its template when asked for one', async () => {
  const ctx = setupTest();

  await startStubParkedAgent(ctx.vsockPath);

  const ping = await waitForAgent(ctx.vsockPath, {
    deadlineMs: 5000,
    isParked: true,
    clock: ctx.clock,
  });

  expect(ping.stage).toBe('template');
});

test('it waits out the deadline on an agent that stays parked when asked for a claimed one', async () => {
  const ctx = setupTest();

  await startStubParkedAgent(ctx.vsockPath);

  const waiting = waitForAgent(ctx.vsockPath, {
    deadlineMs: 1000,
    firstDelayMs: 400,
    maxDelayMs: 400,
    isParked: false,
    clock: ctx.clock,
  });

  const error = await awaitWithClock(ctx.clock, waiting).catch((error_: unknown) => error_);

  expect(String(error)).toBe(
    'Error: agent did not answer within 1000 ms (last error: still parked in the template)',
  );
});

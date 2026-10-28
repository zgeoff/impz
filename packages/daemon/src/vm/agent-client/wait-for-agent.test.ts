import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { startStubParkedAgent } from '../../../testing/vm/start-stub-parked-agent';
import { waitForAgent } from './wait-for-agent';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-wait-agent-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { vsockPath: join(directory, 'vsock.sock'), clock: buildStubClock() };
}

test('it gives up at the deadline of the injected clock, doubling each wait up to its cap', () => {
  const ctx = setupTest();
  const waiting = waitForAgent(ctx.vsockPath, { deadlineMs: 300, clock: ctx.clock });

  expect(waiting).rejects.toThrow(/^agent did not answer within 300 ms \(last error: /u);
  expect(ctx.clock.sleeps).toStrictEqual([5, 10, 20, 40, 80, 100, 100]);
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

  expect(waiting).rejects.toThrowWithMessage(
    Error,
    'agent did not answer within 1000 ms (last error: still parked in the template)',
  );
});

import { expect, mock, test } from 'bun:test';
import { buildMockImpRecord } from '../../../testing/imps/build-mock-imp-record';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { createAgentWatchdog } from './agent-watchdog';

function setupTest() {
  const clock = { nowMs: 0 };
  const logs = captureImpdLogs();

  return {
    clock,
    logs,
    deps: {
      now: () => clock.nowMs,
    },
  };
}

test('it reports a silent agent once, past the timeout and a failed ping', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });
  const recover = mock(() => Promise.resolve(true));

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover,
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 60_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  ctx.clock.nowMs = 62_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toStrictEqual(new Date(0));

  expect(ctx.logs).toStrictEqual([
    'WARNING impd.imps imp=dev the agent has not answered for 60s; its VM still runs (watchdog: report)',
  ]);

  expect(recover).not.toHaveBeenCalled();
});

test('it reports no silence before the timeout', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 59_999;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});

test('it reports no silence for an agent that answers the longer ping', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(false),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 61_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});

test('it ends a reported silence and logs it when the idle loop gets an answer again', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 61_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  ctx.clock.nowMs = 62_000;

  watchdog.observe(imp, true);

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs.at(-1)).toBe('INFO impd.imps imp=dev the agent answers again');
});

test('it backs off restarts, then stops at three an hour', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });
  const recoveredAt: number[] = [];

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => {
      recoveredAt.push(ctx.clock.nowMs);

      return Promise.resolve(true);
    },
    timeoutMs: 60_000,
    action: 'restart',
  });

  for (const durationMs of [60_000, 30_000, 30_000, 120_000, 200_000, 60_000]) {
    watchdog.observe(imp, false);

    ctx.clock.nowMs += durationMs;

    watchdog.observe(imp, false);

    await watchdog.settle();
  }

  expect(recoveredAt).toStrictEqual([60_000, 120_000, 240_000]);
  expect(ctx.logs.filter((line) => line.includes('it only reports now'))).toHaveLength(1);
});

test('it tries a restart another operation held off again at the next look', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });
  const recover = mock(() => Promise.resolve(true)).mockResolvedValueOnce(false);

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover,
    timeoutMs: 60_000,
    action: 'restart',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 60_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  ctx.clock.nowMs = 62_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(recover).toHaveBeenCalledTimes(2);
});

test('it starts the silence of an imp that is held or gone over', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 50_000;

  watchdog.forget(imp.id);
  watchdog.observe(imp, false);

  ctx.clock.nowMs = 70_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});

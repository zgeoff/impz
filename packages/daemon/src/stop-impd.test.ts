import { expect, mock, test } from 'bun:test';
import { stopImpd } from './stop-impd';
import type { ImpdStopParts } from './stop-impd';

// every part as a recorder that stops at once
function setupTest() {
  const parts = {
    diskUsage: { stop: mock(() => {}) },
    tickers: [{ stop: mock(() => Promise.resolve()) }, { stop: mock(() => Promise.resolve()) }],
    https: { stop: mock(() => Promise.resolve()) },
    proxy: { stop: mock(() => Promise.resolve()) },
    broker: { stop: mock(() => Promise.resolve()) },
    egress: { stop: mock(() => {}) },
    ssh: { stop: mock(() => Promise.resolve()) },
    closeExecSessions: mock(() => {}),
    publicMcp: { stop: mock(() => Promise.resolve()) },
    api: { stop: mock(() => Promise.resolve()) },
    imps: {
      sleepAllImps: mock(() => Promise.resolve()),
      waitForLifecycle: mock(() => Promise.resolve()),
      bootTemplates: null,
    },
    storage: { stop: mock(() => Promise.resolve()) },
    stopTelemetry: mock(() => Promise.resolve()),
    db: { destroy: mock(() => Promise.resolve()) },
    log: mock(() => {}),
  } satisfies ImpdStopParts;

  return { parts };
}

test('it stops every part in order, sleeps the imps, then closes the database', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(ctx.parts, { sleepImps: true });

  expect(steps).toStrictEqual([
    { step: 'disk-usage', outcome: 'stopped' },
    { step: 'tickers', outcome: 'stopped' },
    { step: 'https', outcome: 'stopped' },
    { step: 'proxy', outcome: 'stopped' },
    { step: 'broker', outcome: 'stopped' },
    { step: 'egress', outcome: 'stopped' },
    { step: 'ssh', outcome: 'stopped' },
    { step: 'exec-sessions', outcome: 'stopped' },
    { step: 'public-mcp', outcome: 'stopped' },
    { step: 'api', outcome: 'stopped' },
    { step: 'sleep', outcome: 'stopped' },
    { step: 'templates', outcome: 'stopped' },
    { step: 'storage', outcome: 'stopped' },
    { step: 'telemetry', outcome: 'stopped' },
    { step: 'database', outcome: 'stopped' },
  ]);
});

test('it ends every open connection when it stops the api', async () => {
  const ctx = setupTest();

  await stopImpd(ctx.parts, { sleepImps: true });

  expect(ctx.parts.api.stop).toHaveBeenCalledExactlyOnceWith(true);
});

test('it sleeps every imp before it stops storage', async () => {
  const ctx = setupTest();

  await stopImpd(ctx.parts, { sleepImps: true });

  expect(ctx.parts.imps.sleepAllImps).toHaveBeenCalledBefore(ctx.parts.storage.stop);
});

test('it waits for the lifecycle and sleeps no imp when it stops for a restart in place', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(ctx.parts, { sleepImps: false });

  expect(steps).toPartiallyContain({ step: 'lifecycle', outcome: 'stopped' });
  expect(ctx.parts.imps.sleepAllImps).not.toHaveBeenCalled();
});

test('it skips the parts the config leaves off, and leaves a caller database open', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(
    { ...ctx.parts, https: null, ssh: null, publicMcp: null, stopTelemetry: null, db: null },
    { sleepImps: true },
  );

  expect(steps.map((entry) => entry.step)).toStrictEqual([
    'disk-usage',
    'tickers',
    'proxy',
    'broker',
    'egress',
    'exec-sessions',
    'api',
    'sleep',
    'templates',
    'storage',
  ]);
});

test('it logs a step that fails and goes on to the next', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(
    { ...ctx.parts, proxy: { stop: () => Promise.reject(new Error('port gone')) } },
    { sleepImps: true },
  );

  expect(steps).toPartiallyContain({ step: 'proxy', outcome: 'failed' });
  expect(ctx.parts.log).toHaveBeenCalledWith('impd: stop: proxy failed: port gone');
  expect(ctx.parts.broker.stop).toHaveBeenCalledOnce();
});

test('it goes on past a step still running at its limit', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(
    { ...ctx.parts, proxy: { stop: () => new Promise<void>(() => {}) } },
    { sleepImps: true, stepMaxMs: 5 },
  );

  expect(steps).toPartiallyContain({ step: 'proxy', outcome: 'timed-out' });
  expect(ctx.parts.log).toHaveBeenCalledWith('impd: stop: proxy still running after 5ms; going on');
  expect(ctx.parts.db.destroy).toHaveBeenCalledOnce();
});

test('it leaves the database open while a sleep still runs at the deadline', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(
    {
      ...ctx.parts,
      imps: { ...ctx.parts.imps, sleepAllImps: () => new Promise<void>(() => {}) },
    },
    { sleepImps: true, deadlineMs: 50 },
  );

  expect(steps).toPartiallyContain({ step: 'sleep', outcome: 'timed-out' });
  expect(ctx.parts.db.destroy).not.toHaveBeenCalled();
});

import { expect, mock, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import { captureImpdLogs } from '../testing/platform/capture-impd-logs';
import { stopImpd } from './stop-impd';
import type { ImpdStopParts } from './stop-impd';

function setupTest() {
  const firstTicker = { stop: mock(() => Promise.resolve()) };
  const secondTicker = { stop: mock(() => Promise.resolve()) };

  const parts = {
    dbWrites: { stop: mock(() => Promise.resolve()) },
    diskUsage: { stop: mock(() => {}) },
    tickers: [firstTicker, secondTicker],
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
  } satisfies ImpdStopParts;

  const logs = captureImpdLogs();

  return { parts, firstTicker, secondTicker, logs };
}

test('it stops every part in order, sleeps the imps, then closes the database', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(ctx.parts, { sleepImps: true });

  expect(steps).toStrictEqual([
    { step: 'db-writes', outcome: 'stopped' },
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

test('it calls the stop of every part once, in order', async () => {
  const ctx = setupTest();

  await stopImpd(ctx.parts, { sleepImps: true });

  expect(ctx.parts.dbWrites.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.diskUsage.stop).toHaveBeenCalledOnce();
  expect(ctx.firstTicker.stop).toHaveBeenCalledOnce();
  expect(ctx.secondTicker.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.https.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.proxy.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.broker.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.egress.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.ssh.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.closeExecSessions).toHaveBeenCalledOnce();
  expect(ctx.parts.publicMcp.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.api.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.imps.sleepAllImps).toHaveBeenCalledOnce();
  expect(ctx.parts.storage.stop).toHaveBeenCalledOnce();
  expect(ctx.parts.stopTelemetry).toHaveBeenCalledOnce();
  expect(ctx.parts.db.destroy).toHaveBeenCalledOnce();
  expect(ctx.parts.dbWrites.stop).toHaveBeenCalledBefore(ctx.parts.diskUsage.stop);
  expect(ctx.parts.diskUsage.stop).toHaveBeenCalledBefore(ctx.firstTicker.stop);
  expect(ctx.secondTicker.stop).toHaveBeenCalledBefore(ctx.parts.https.stop);
  expect(ctx.parts.https.stop).toHaveBeenCalledBefore(ctx.parts.proxy.stop);
  expect(ctx.parts.proxy.stop).toHaveBeenCalledBefore(ctx.parts.broker.stop);
  expect(ctx.parts.broker.stop).toHaveBeenCalledBefore(ctx.parts.egress.stop);
  expect(ctx.parts.egress.stop).toHaveBeenCalledBefore(ctx.parts.ssh.stop);
  expect(ctx.parts.ssh.stop).toHaveBeenCalledBefore(ctx.parts.closeExecSessions);
  expect(ctx.parts.closeExecSessions).toHaveBeenCalledBefore(ctx.parts.publicMcp.stop);
  expect(ctx.parts.publicMcp.stop).toHaveBeenCalledBefore(ctx.parts.api.stop);
  expect(ctx.parts.api.stop).toHaveBeenCalledBefore(ctx.parts.imps.sleepAllImps);
  expect(ctx.parts.storage.stop).toHaveBeenCalledBefore(ctx.parts.stopTelemetry);
  expect(ctx.parts.stopTelemetry).toHaveBeenCalledBefore(ctx.parts.db.destroy);
});

test('it waits for a stop under way before it stops the next part', async () => {
  const ctx = setupTest();
  const held = Promise.withResolvers<void>();
  const proxy = { stop: mock(() => held.promise) };
  const stopping = stopImpd({ ...ctx.parts, proxy }, { sleepImps: true });

  await waitFor(() => {
    expect(proxy.stop).toHaveBeenCalledOnce();
  });

  const brokerStopsWhileHeld = ctx.parts.broker.stop.mock.calls.length;

  held.resolve();

  await stopping;

  expect(brokerStopsWhileHeld).toBe(0);
  expect(ctx.parts.broker.stop).toHaveBeenCalledOnce();
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

  expect(ctx.logs).toContainEqual(
    expect.stringMatching(/^INFO impd\.stop every imp asleep in \d+ms$/v),
  );
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
    'db-writes',
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
  expect(ctx.logs).toContain('WARNING impd.stop proxy failed: port gone');
  expect(ctx.parts.broker.stop).toHaveBeenCalledOnce();
});

test('it goes on past a step still running at its limit', async () => {
  const ctx = setupTest();

  const steps = await stopImpd(
    { ...ctx.parts, proxy: { stop: () => new Promise<void>(() => {}) } },
    { sleepImps: true, stepMaxMs: 5 },
  );

  expect(steps).toPartiallyContain({ step: 'proxy', outcome: 'timed-out' });
  expect(ctx.logs).toContain('INFO impd.stop proxy still running after 5ms; going on');
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

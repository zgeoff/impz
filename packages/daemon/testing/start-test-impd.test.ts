import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpClient } from '@impz/client';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { IMPD_STARTUP_STEPS } from '../src/impd-startup-steps';
import { listImps } from '../src/platform/db/imps';
import { startTestImpd } from './start-test-impd';
import { StubVmError } from './vm/build-stub-vmm';

test('it runs every startup step that main.ts runs, in order', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  expect(harness.impd.startup).toStrictEqual([...IMPD_STARTUP_STEPS]);
});

test('it boots imps on the stub VMM', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(harness.db);

  invariant(typeof imp?.pid === 'number');

  expect(imp.state).toBe('running');
  expect(harness.fake.alive.has(imp.pid)).toBeTrue();
});

test('it serves the API to its root client', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const imps = await harness.client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('it serves the API on a loopback port', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { rootToken: 'loopback-token' });

  const client = createImpClient({ url: harness.url, token: 'loopback-token' });

  const info = await client.system.info();

  expect(info.storage.backend).toBe('xfs');
});

test('it refuses a client whose token impd never issued', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  expect(harness.buildClient('unknown-token').imps.list({})).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
});

test('it records an unexpected RPC failure in the harness', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await harness.createTestImage('ubuntu');

  harness.fake.queue('boot', 'fail');

  expect(harness.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  expect(harness.rpcFailures).toStrictEqual([expect.any(StubVmError)]);
});

test('it logs an unexpected RPC failure to the harness log', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await harness.createTestImage('ubuntu');

  harness.fake.queue('boot', 'fail');

  expect(harness.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  expect(harness.logs).toSatisfyAny(
    (line: string) =>
      line.startsWith('impd: rpc failed: ') && line.includes('StubVmError: boot failed: no agent'),
  );
});

test('it records no failure the API returns as an expected error', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  expect(harness.client.imps.get({ name: 'missing' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });

  expect(harness.rpcFailures).toBeEmpty();
});

test('it runs a ticker only when the test fires it', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  expect(harness.tickers.readDelays()).toMatchObject({
    idle: 2000,
    governor: expect.any(Number) as unknown,
  });
});

test('it re-adopts a running VM in the impd that restartImpd starts', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const [before] = await listImps(harness.db);

  await harness.restartImpd();

  const [after] = await listImps(harness.db);

  invariant(before);

  expect(after).toMatchObject({ state: 'running', pid: before.pid });
});

test('it serves the impd that restartImpd starts on the port of the one it replaced', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  const replaced = harness.url;

  await harness.restartImpd();

  const response = await fetch(`${replaced}/health`);

  expect(harness.url).toBe(replaced);
  expect(response.status).toBe(200);
});

test('it has its data dir removed by the stack', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await stack.disposeAsync();

  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('it has its database closed by the stack', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await stack.disposeAsync();

  expect(listImps(harness.db)).rejects.toThrow();
});

test('it keeps a data dir the caller passed', async () => {
  // registered first, so the impd stops before its data dir goes
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  await startTestImpd(stack, { dataDir });

  await stack.disposeAsync();

  expect(existsSync(dataDir)).toBeTrue();
});

test('it has its data dir removed by the stack after a setup step throws', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const seen: string[] = [];

  const failure = await startTestImpd(stack, {
    createStorage: (dataDir) => {
      seen.push(dataDir);
      throw new Error('no storage');
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await stack.disposeAsync();

  expect(failure).toMatchObject({ message: 'no storage' });
  expect(seen.map((dataDir) => existsSync(dataDir))).toStrictEqual([false]);
});

test('it finishes a running template build before it removes its data dir', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const logs: string[] = [];

  const harness = await startTestImpd(stack, {
    env: { IMP_BOOT_TEMPLATES: 'true' },
    onLog: (message) => {
      logs.push(message);
    },
  });

  await harness.createTestImage('ubuntu');

  const held = harness.fake.hold('template');

  // the first release once the stack unwinds; the harness's own wait
  // for the build comes after it
  stack.defer(() => {
    held.release();
  });

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await held.reached;

  await stack.disposeAsync();

  const builtAt = logs.findIndex((line) => /^impd: boot template \w+ built in/u.test(line));

  expect(builtAt).toBeGreaterThanOrEqual(0);
  expect(builtAt).toBeLessThan(logs.indexOf('test harness: database closed'));
  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('it serves the API on loopback only', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  expect(harness.impd.app.server?.hostname).toBe('127.0.0.1');
});

test('it parks a boot the replaced impd had hung, so the boot never finishes', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  await harness.createTestImage('ubuntu');

  harness.fake.queue('boot', 'hang');
  void Promise.allSettled([harness.imps.createImp({ name: 'dev' })]);

  await waitFor(() => {
    expect(harness.fake.countHungCalls()).toBe(1);
  });

  await harness.restartImpd();

  await waitFor(() => {
    expect(harness.fake.countParkedCalls()).toBe(1);
  });
});

test('it releases a hung template build before it waits for the build', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { env: { IMP_BOOT_TEMPLATES: 'true' } });

  await harness.createTestImage('ubuntu');

  harness.fake.queue('template', 'hang');

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await waitFor(() => {
    expect(harness.fake.countHungCalls()).toBe(1);
  });

  await stack.disposeAsync();

  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('it never waits for the template build of an impd that restartImpd replaced', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { env: { IMP_BOOT_TEMPLATES: 'true' } });

  await harness.createTestImage('ubuntu');

  const held = harness.fake.hold('template');

  stack.defer(() => {
    held.release();
  });

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await held.reached;

  await harness.restartImpd();

  held.release();

  await waitFor(() => {
    expect(harness.fake.countParkedCalls()).toBe(1);
  });

  await stack.disposeAsync();

  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('it settles the template build of a replaced impd before it closes the database', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const logs: string[] = [];

  const harness = await startTestImpd(stack, {
    env: { IMP_BOOT_TEMPLATES: 'true' },
    onLog: (message) => {
      logs.push(message);
    },
  });

  await harness.createTestImage('ubuntu');

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await waitFor(() => {
    expect(harness.fake.templateBuilds).toHaveLength(1);
  });

  // the next impd's startup may remove the build's work dir as a build cut short, so the
  // build either finishes or fails
  await harness.restartImpd();
  await stack.disposeAsync();

  const settledAt = logs.findIndex((line) =>
    /^impd: boot template \w+ (?:built in|build failed)/u.test(line),
  );

  expect(settledAt).toBeGreaterThanOrEqual(0);
  expect(settledAt).toBeLessThan(logs.indexOf('test harness: database closed'));
  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('it moves a frozen clock when the test advances it', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { frozenClockMs: 1_000_000 });

  harness.advance(500);

  expect(harness.now()).toBe(1_000_500);
});

test('it freezes the clock at the time the test sets', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { frozenClockMs: 1_000_000 });

  harness.advance(500);
  harness.setClock(2_000_000);

  expect(harness.now()).toBe(2_000_000);
});

test('it moves a frozen clock by the pauses of a young guest wait', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' },
    frozenClockMs: 1_000_000,
  });

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  harness.fake.setGuestUptime(100);

  await harness.imps.sleepImp('dev');

  expect(harness.now()).toBe(1_000_200);
});

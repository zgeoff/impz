import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { startStubSilentOrigin } from '../../../testing/network/start-stub-silent-origin';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { sendLongRequest } from './send-long-request';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const origin = startStubSilentOrigin(stack);

  return { stack, origin };
}

test('it ends a call with no answer at its deadline, and aborts the request', async () => {
  const ctx = setupTest();
  const clock = buildStubClock();

  const call = sendLongRequest(
    `${ctx.origin.origin}/long`,
    { method: 'POST', body: 'the long call' },
    {
      deadline: { delayMs: 3_600_000, buildError: () => new Error('no answer in 60 minutes') },
      startTimer: clock.startTimer,
    },
  );

  await ctx.origin.longHeld;

  const pendingMs = clock.readPendingMs();

  clock.runFor(3_600_000);

  expect(pendingMs).toStrictEqual([3_600_000]);
  expect(call).rejects.toThrowWithMessage(Error, 'no answer in 60 minutes');

  await expect(ctx.origin.longGone).toResolve();
});

test('it stops the deadline once the answer comes', async () => {
  const ctx = setupTest();
  const clock = buildStubClock();

  const control = new AbortController();

  const controlCall = fetch(`${ctx.origin.origin}/control`, {
    method: 'POST',
    body: 'the control call',
    signal: control.signal,
  });

  const call = sendLongRequest(
    `${ctx.origin.origin}/long`,
    { method: 'POST', body: 'the long call' },
    {
      deadline: { delayMs: 3_600_000, buildError: () => new Error('no answer in 60 minutes') },
      startTimer: clock.startTimer,
    },
  );

  await Promise.all([ctx.origin.controlHeld, ctx.origin.longHeld]);

  control.abort();

  await Promise.allSettled([controlCall]);

  const response = await call;
  const text = await response.text();

  expect(text).toBe('the long answer');
  expect(clock.countPending()).toBe(0);
});

test('it ends a call when its caller’s signal aborts before the deadline', async () => {
  const ctx = setupTest();
  const clock = buildStubClock();

  const caller = new AbortController();

  const call = sendLongRequest(
    `${ctx.origin.origin}/long`,
    { method: 'POST', body: 'the long call', signal: caller.signal },
    {
      deadline: { delayMs: 3_600_000, buildError: () => new Error('no answer in 60 minutes') },
      startTimer: clock.startTimer,
    },
  );

  await ctx.origin.longHeld;

  caller.abort();

  expect(call).rejects.toMatchObject({ name: 'AbortError' });

  await expect(ctx.origin.longGone).toResolve();
});

// Bun reads its fetch idle limit (360 s by default) only at startup, so a
// child Bun runs with 1 s; its plain fetch is the control that the limit
// expires, after about 8 s
test('it gets an answer that stays silent past Bun’s idle limit, where a plain fetch gives up', async () => {
  const ctx = setupTest();

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../../../testing/surface/run-idle-limited-requests.ts'),
      JSON.stringify({ origin: ctx.origin.origin, via: 'long-request' }),
    ],
    {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  ctx.stack.defer(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  const lines = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: false, error: 'TimeoutError' },
    { kind: 'long', isOk: true, status: 200, body: 'the long answer' },
  ]);
  // oxlint-disable-next-line zgeoff/max-test-timeout -- 8.2 s on CI; floor: Bun's fetch idle limit fires at 8.0 s for BUN_CONFIG_HTTP_IDLE_TIMEOUT 1 or 2, and a fraction turns it off
}, 16_000);

import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPCError } from '@impz/client';
import { fireNextTimer } from '@impz/shared/test-utils/fire-next-timer';
import { waitFor } from '@zgeoff/testing';
import { createFakeClock } from '@zgeoff/testing/clock';
import invariant from 'tiny-invariant';
import { UsageError } from '../cli/usage-error';
import { writeHostConfig } from '../config/read-host-config';
import { buildMockSavedTarget } from '../test-utils/build-mock-saved-target';
import { listSavedTargets, runOnHosts } from './run-on-hosts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-fan-out-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { env: { XDG_CONFIG_HOME: directory } };
}

test('#runOnHosts gives each host its own answer or error, and a silent one the timeout', async () => {
  const signals: AbortSignal[] = [];
  const timeouts = createFakeClock();

  const replies = [
    () => Promise.resolve('imps'),

    () => new Promise<string>(() => {}),
    () => Promise.reject(new ORPCError('UNAUTHORIZED', { status: 401 })),
  ];

  const answers = runOnHosts(
    [
      buildMockSavedTarget({ host: 'box' }),
      buildMockSavedTarget({ host: 'laptop' }),
      buildMockSavedTarget({ host: 'old', config: { url: 'http://old:7070' } }),
    ],
    (_client, signal) => {
      signals.push(signal);

      const reply = replies.shift();

      invariant(reply);

      return reply();
    },
    50,
    timeouts.schedule,
  );

  await waitFor(() => {
    expect({ delays: timeouts.delays, pending: timeouts.countPending() }).toStrictEqual({
      delays: [50, 50, 50],
      pending: 1,
    });
  });

  fireNextTimer(timeouts);

  const settled = await answers;

  expect(settled).toStrictEqual([
    { host: 'box', value: 'imps' },
    { host: 'laptop', error: 'no answer in 0.05 s' },
    {
      host: 'old',
      error:
        'unauthorized: old (http://old:7070) refused the token; run impz login http://old:7070 --name old',
    },
  ]);
});

test('#runOnHosts gives each host a timer of the timeout, cancelled once it answers', async () => {
  const timeouts = createFakeClock();

  await runOnHosts([buildMockSavedTarget()], () => Promise.resolve('imps'), 50, timeouts.schedule);

  expect({ delays: timeouts.delays, pending: timeouts.countPending() }).toStrictEqual({
    delays: [50],
    pending: 0,
  });
});

test('#runOnHosts aborts each host’s requests once its answer is in, the silent one’s by the timeout', async () => {
  const signals: AbortSignal[] = [];
  const timeouts = createFakeClock();

  const replies = [
    () => Promise.resolve('imps'),
    () => new Promise<string>(() => {}),
    () => Promise.reject(new Error('no such procedure')),
  ];

  const answers = runOnHosts(
    [buildMockSavedTarget(), buildMockSavedTarget(), buildMockSavedTarget()],
    (_client, signal) => {
      signals.push(signal);

      const reply = replies.shift();

      invariant(reply);

      return reply();
    },
    50,
    timeouts.schedule,
  );

  await waitFor(() => {
    expect(signals.filter((signal) => signal.aborted)).toHaveLength(2);
  });

  fireNextTimer(timeouts);

  await answers;

  expect(signals).toSatisfyAll((signal: AbortSignal) => signal.aborted);
});

test('#runOnHosts waits on the real clock when no timer is passed', async () => {
  const answers = await runOnHosts(
    [buildMockSavedTarget({ host: 'laptop' })],
    () => new Promise<string>(() => {}),
    1,
  );

  expect(answers).toStrictEqual([{ host: 'laptop', error: 'no answer in 0.001 s' }]);
});

test('#runOnHosts aborts the requests still open beside a call that fails', async () => {
  const signals: AbortSignal[] = [];

  const answers = await runOnHosts([buildMockSavedTarget({ host: 'box' })], (_client, signal) => {
    signals.push(signal);

    return Promise.all([
      Promise.reject(new Error('no such procedure')),
      new Promise<never>(() => {}),
    ]);
  });

  expect(answers).toStrictEqual([{ host: 'box', error: 'no such procedure' }]);
  expect(signals).toSatisfyAll((signal: AbortSignal) => signal.aborted);
});

test('#listSavedTargets lists the saved hosts in name order', () => {
  const ctx = setupTest();

  writeHostConfig(ctx.env, {
    current: 'zeta',
    hosts: {
      zeta: { url: 'http://zeta:7070', token: 'z' },
      alpha: { url: 'http://alpha:7070', token: null },
    },
  });

  expect(listSavedTargets(ctx.env)).toStrictEqual([
    { host: 'alpha', config: { url: 'http://alpha:7070', token: null, host: 'alpha' } },
    { host: 'zeta', config: { url: 'http://zeta:7070', token: 'z', host: 'zeta' } },
  ]);
});

test('#listSavedTargets rejects a config with no saved hosts', () => {
  const ctx = setupTest();

  expect(() => listSavedTargets(ctx.env)).toThrowWithMessage(
    UsageError,
    'no saved hosts (see impz login)',
  );
});

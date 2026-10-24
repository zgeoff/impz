import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HEADSCALE_IMAGES } from '../../scripts/dev/headscale-images';
import { HEADSCALE_LOGIN_SERVER, startHeadscale, stopHeadscale } from './headscale';
import { runChecked, runCommand } from './instance';
import { removeDockerNetwork } from './remove-docker-network';
import { waitFor } from './wait-for';
import { writeMetric } from './write-metric';

function setupTest() {
  const container = `imp-headscale-${String(process.pid)}-${randomUUID().slice(0, 8)}`;

  // Cleanup runs first in, first out, so this runs before a test's own while
  // its nodes still hold the network.
  onTestFinished(() => removeDockerNetwork({ runCommand }, `${container}-ts`));

  return { container, runners: { runCommand, runChecked } };
}

// One topology for both ports: a tagged peer and caller, and the member. Each probe waits 1 s, as
// a dropped port answers nothing and an open one answers at once.
test('it lets one tag:imp-e2e node reach another on port 7070, and refuses it the port 7071 that a member reaches', async () => {
  const ctx = setupTest();
  const started = performance.now();
  const spans = { headscaleMs: 0, peerAddressMs: 0, pingMs: 0, memberReachMs: 0, callerReachMs: 0 };

  const tailnet = await startHeadscale(ctx.runners, ctx.container);

  spans.headscaleMs = Math.round(performance.now() - started);

  const [peerIP, callerIP] = await Promise.all(
    ['peer', 'caller'].map(async (node) => {
      const name = `${ctx.container}-${node}`;

      await runChecked([
        'docker',
        'run',
        '-d',
        '--name',
        name,
        '--network',
        tailnet.network,
        '--cap-add',
        'NET_ADMIN',
        '--device',
        '/dev/net/tun',
        '-e',
        `TS_AUTHKEY=${tailnet.key}`,
        '-e',
        'TS_USERSPACE=false',
        '-e',
        `TS_EXTRA_ARGS=--login-server=${HEADSCALE_LOGIN_SERVER}`,
        HEADSCALE_IMAGES.tailscale,
      ]);

      onTestFinished(() => runCommand(['docker', 'rm', '-f', name]));

      const address = await waitFor(`the ${node}’s tailnet address`, () =>
        runChecked(['docker', 'exec', name, 'tailscale', 'ip', '-4']),
      );

      return address.trim();
    }),
  );

  const memberAddress = await runChecked([
    'docker',
    'exec',
    tailnet.member,
    'tailscale',
    'ip',
    '-4',
  ]);

  const memberIP = memberAddress.trim();

  spans.peerAddressMs = Math.round(performance.now() - started);

  await runChecked([
    'docker',
    'exec',
    '-d',
    `${ctx.container}-peer`,
    'sh',
    '-c',
    'while true; do echo open | nc -l -p 7071; done',
  ]);

  await runChecked([
    'docker',
    'exec',
    '-d',
    `${ctx.container}-peer`,
    'sh',
    '-c',
    'while true; do echo open | nc -l -p 7070; done',
  ]);

  const pings = await Promise.all(
    [
      [tailnet.member, peerIP],
      [`${ctx.container}-caller`, peerIP],
      [`${ctx.container}-peer`, memberIP],
      [`${ctx.container}-peer`, callerIP ?? ''],
    ].map(async ([from, to]) => {
      const pingStarted = performance.now();

      const result = await runCommand([
        'docker',
        'exec',
        from ?? '',
        'tailscale',
        'ping',
        '--c',
        '30',
        '--timeout',
        '1s',
        to ?? '',
      ]);

      return {
        from,
        elapsedMs: Math.round(performance.now() - pingStarted),
        exitCode: result.exitCode,
        out: `${result.stdout}${result.stderr}`.trim().split('\n').slice(-3),
      };
    }),
  );

  writeMetric('headscalePings', pings);

  spans.pingMs = Math.round(performance.now() - started);

  const attempts: { node: string; elapsedMs: number; answer: string }[] = [];

  const [, reply] = await Promise.all([
    waitFor('the peer’s port 7071 from the member', async () => {
      const answer = await runCommand([
        'docker',
        'exec',
        tailnet.member,
        'nc',
        '-w',
        '1',
        peerIP ?? '',
        '7071',
      ]);

      attempts.push({
        node: 'member',
        elapsedMs: Math.round(performance.now() - started),
        answer: answer.stdout.trim(),
      });

      if (answer.stdout.trim() !== 'open') {
        throw new Error('no answer yet');
      }

      spans.memberReachMs = Math.round(performance.now() - started);
    }),
    waitFor('the peer’s port 7070 from the caller', async () => {
      const answer = await runCommand([
        'docker',
        'exec',
        `${ctx.container}-caller`,
        'nc',
        '-w',
        '1',
        peerIP ?? '',
        '7070',
      ]);

      attempts.push({
        node: 'caller',
        elapsedMs: Math.round(performance.now() - started),
        answer: answer.stdout.trim(),
      });

      if (answer.stdout.trim() === '') {
        throw new Error('no answer yet');
      }

      spans.callerReachMs = Math.round(performance.now() - started);

      return answer.stdout.trim();
    }),
  ]);

  writeMetric('headscaleAttempts', attempts);

  const refused = await runCommand([
    'docker',
    'exec',
    `${ctx.container}-caller`,
    'nc',
    '-w',
    '1',
    peerIP ?? '',
    '7071',
  ]);

  writeMetric('headscaleSpansMs', spans);

  expect(reply).toBe('open');
  expect(refused.stdout).toBe('');
}, 180_000);

test('it removes Headscale, its member and its network when the run stops it', async () => {
  const ctx = setupTest();

  await startHeadscale(ctx.runners, ctx.container);
  await stopHeadscale(ctx.runners, ctx.container);

  const left = await runCommand([
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^${ctx.container}-`,
    '--format',
    '{{.Names}}',
  ]);

  const network = await runCommand(['docker', 'network', 'inspect', `${ctx.container}-ts`]);

  expect(left.stdout).toBe('');
  expect(network.exitCode).not.toBe(0);
}, 120_000);

test('it removes a Headscale whose member never started', async () => {
  const ctx = setupTest();

  await startHeadscale(ctx.runners, ctx.container);
  await runChecked(['docker', 'rm', '-f', `${ctx.container}-ts-member`]);
  await stopHeadscale(ctx.runners, ctx.container);

  const left = await runCommand([
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^${ctx.container}-`,
    '--format',
    '{{.Names}}',
  ]);

  expect(left.stdout).toBe('');
}, 120_000);

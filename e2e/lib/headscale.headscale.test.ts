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
  const spans = { headscaleMs: 0, peerAddressMs: 0, memberReachMs: 0, callerReachMs: 0 };

  const tailnet = await startHeadscale(ctx.runners, ctx.container);

  spans.headscaleMs = Math.round(performance.now() - started);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    `${ctx.container}-peer`,
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

  onTestFinished(() => runCommand(['docker', 'rm', '-f', `${ctx.container}-peer`]));

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    `${ctx.container}-caller`,
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

  onTestFinished(() => runCommand(['docker', 'rm', '-f', `${ctx.container}-caller`]));

  const peerAddress = await waitFor('the peer’s tailnet address', () =>
    runChecked(['docker', 'exec', `${ctx.container}-peer`, 'tailscale', 'ip', '-4']),
  );

  const peerIP = peerAddress.trim();

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

  await waitFor('the peer’s port 7071 from the member', async () => {
    const answer = await runChecked([
      'docker',
      'exec',
      tailnet.member,
      'nc',
      '-w',
      '1',
      peerIP,
      '7071',
    ]);

    if (answer.trim() !== 'open') {
      throw new Error('no answer yet');
    }
  });

  spans.memberReachMs = Math.round(performance.now() - started);

  const reply = await waitFor('the peer’s port 7070 from the caller', async () => {
    const answer = await runChecked([
      'docker',
      'exec',
      `${ctx.container}-caller`,
      'nc',
      '-w',
      '1',
      peerIP,
      '7070',
    ]);

    if (answer.trim() === '') {
      throw new Error('no answer yet');
    }

    return answer.trim();
  });

  spans.callerReachMs = Math.round(performance.now() - started);

  const refused = await runCommand([
    'docker',
    'exec',
    `${ctx.container}-caller`,
    'nc',
    '-w',
    '1',
    peerIP,
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

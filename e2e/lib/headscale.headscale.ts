import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HEADSCALE_IMAGES } from '../../scripts/dev/headscale-images';
import { HEADSCALE_LOGIN_SERVER, startHeadscale, stopHeadscale } from './headscale';
import { runChecked, runCommand } from './instance';
import { waitFor } from './wait-for';

function setupTest() {
  const container = `imp-headscale-${String(process.pid)}-${randomUUID().slice(0, 8)}`;

  // Cleanup runs first in, first out, so this runs before a test's own and
  // removes every container that holds the network.
  onTestFinished(async () => {
    await runCommand([
      'docker',
      'rm',
      '-f',
      `${container}-ts-member`,
      `${container}-headscale`,
      `${container}-peer`,
      `${container}-caller`,
    ]);

    await runCommand(['docker', 'network', 'rm', `${container}-ts`]);
  });

  return { container, runners: { runCommand, runChecked } };
}

test('it lets one tag:imp-e2e node reach another on port 7070', async () => {
  const ctx = setupTest();

  const tailnet = await startHeadscale(ctx.runners, ctx.container);

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

  await runChecked([
    'docker',
    'exec',
    '-d',
    `${ctx.container}-peer`,
    'sh',
    '-c',
    'while true; do echo open | nc -l -p 7070; done',
  ]);

  const reply = await waitFor('the peer’s port 7070 from the caller', async () => {
    const answer = await runChecked([
      'docker',
      'exec',
      `${ctx.container}-caller`,
      'nc',
      '-w',
      '5',
      peerIP,
      '7070',
    ]);

    if (answer.trim() === '') {
      throw new Error('no answer yet');
    }

    return answer.trim();
  });

  expect(reply).toBe('open');
}, 180_000);

test('it refuses one tag:imp-e2e node the port 7071 of another, which a member reaches', async () => {
  const ctx = setupTest();

  const tailnet = await startHeadscale(ctx.runners, ctx.container);

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
      '5',
      peerIP,
      '7071',
    ]);

    if (answer.trim() !== 'open') {
      throw new Error('no answer yet');
    }
  });

  await waitFor('the peer’s port 7070 from the caller', async () => {
    const answer = await runChecked([
      'docker',
      'exec',
      `${ctx.container}-caller`,
      'nc',
      '-w',
      '5',
      peerIP,
      '7070',
    ]);

    if (answer.trim() !== 'open') {
      throw new Error('no answer yet');
    }
  });

  const refused = await runCommand([
    'docker',
    'exec',
    `${ctx.container}-caller`,
    'nc',
    '-w',
    '5',
    peerIP,
    '7071',
  ]);

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

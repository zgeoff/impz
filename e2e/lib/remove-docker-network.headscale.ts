import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HEADSCALE_IMAGES } from '../../scripts/dev/headscale-images';
import { runChecked, runCommand } from './instance';
import { removeDockerNetwork } from './remove-docker-network';

function setupTest() {
  const network = `imp-network-${String(process.pid)}-${randomUUID().slice(0, 8)}`;

  return { network, runners: { runCommand } };
}

test('it removes a network and the containers that still hold it', async () => {
  const ctx = setupTest();

  await runChecked(['docker', 'network', 'create', ctx.network]);

  onTestFinished(async () => {
    await runCommand(['docker', 'rm', '-f', `${ctx.network}-peer`, `${ctx.network}-caller`]);
    await runCommand(['docker', 'network', 'rm', ctx.network]);
  });

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    `${ctx.network}-peer`,
    '--network',
    ctx.network,
    '--entrypoint',
    'sleep',
    HEADSCALE_IMAGES.tailscale,
    'infinity',
  ]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    `${ctx.network}-caller`,
    '--network',
    ctx.network,
    '--entrypoint',
    'sleep',
    HEADSCALE_IMAGES.tailscale,
    'infinity',
  ]);

  await removeDockerNetwork(ctx.runners, ctx.network);

  const containers = await runCommand([
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^${ctx.network}-`,
    '--format',
    '{{.Names}}',
  ]);

  const network = await runCommand(['docker', 'network', 'inspect', ctx.network]);

  expect(containers.stdout).toBe('');
  expect(network.exitCode).not.toBe(0);
}, 60_000);

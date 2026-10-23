import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHeadscale, stopHeadscale } from './headscale';
import { runChecked, runCommand } from './instance';

function setupTest() {
  const container = `imp-headscale-${String(process.pid)}-${randomUUID().slice(0, 8)}`;

  onTestFinished(async () => {
    await runCommand(['docker', 'rm', '-f', `${container}-ts-member`, `${container}-headscale`]);
    await runCommand(['docker', 'network', 'rm', `${container}-ts`]);
  });

  return { container, runners: { runCommand, runChecked } };
}

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

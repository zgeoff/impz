import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  assertState,
  createInstanceClient,
  readImp,
  requireImp,
  runImp,
  runImpWith,
  tryImp,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { HOST_B, readMoveHosts } from '@impz/e2e-harness/move-hosts';
import { writeBothHostsConfig } from '@impz/e2e-harness/move-steps';
import { registerMoveRemoval } from '@impz/e2e-harness/register-move-removal';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import * as z from 'zod';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.hostB);

  return { prefix: getSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it creates on the saved host with the most free RAM for impz new --place', async () => {
  const ctx = await setupTest();

  const seed = `${ctx.prefix}seed`;
  const filler = `${ctx.prefix}filler`;
  const placed = `${ctx.prefix}placed`;

  const configDir = await mkdtemp(join(tmpdir(), 'imp-mv-both-'));

  ctx.stack.defer(() => rm(configDir, { recursive: true, force: true }));

  const bothEnv = await writeBothHostsConfig(ctx.hosts, configDir);

  // A cold move gives B the tiny image, so only the room tells the two hosts
  // apart; without it the tie would go to A, first by name.
  await runImp('new', seed, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerMoveRemoval(ctx.stack, config.keep, { source: ctx.client, target: ctx.clientB }, seed);

  await waitForExec(seed);
  await runImp('stop', seed);
  await runImpWith({ env: ctx.hosts.cliEnv }, 'move', seed, HOST_B);
  await runImpWith({ target: ctx.hosts.hostB }, 'rm', seed);

  // A's sleeper counts its whole memory as taken, which leaves A less free RAM
  // than B.
  await runImp('new', filler, '--image', resolveImageName('e2e-tiny'), '--memory', '1024');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, filler));

  await waitForExec(filler);
  await runImp('sleep', filler);
  await waitFor(`${filler} to sleep`, () => assertState(filler, 'sleeping'));

  const result = await tryImp(
    [
      'new',
      placed,
      '--place',
      '--image',
      resolveImageName('e2e-tiny'),
      '--memory',
      '256',
      '--json',
    ],
    { env: bothEnv },
  );

  registerMoveRemoval(ctx.stack, config.keep, { source: ctx.client, target: ctx.clientB }, placed);

  const onA = await readImp(placed);
  const onB = await requireImp(placed, ctx.hosts.hostB);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: expect.toBeString(),
    stderr: expect.toInclude(`impz: placing on ${HOST_B}`),
  });

  expect(result.stderr).not.toContain('skipped');

  const printed: unknown = JSON.parse(result.stdout);
  const body = z.object({ host: z.string(), imp: z.object({ name: z.string() }) }).parse(printed);

  expect(body).toStrictEqual({ host: HOST_B, imp: { name: placed } });
  expect(onA).toBeUndefined();
  expect(onB.name).toBe(placed);
});

import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, runImpWith } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { HOST_B, readMoveHosts } from '@impz/e2e-harness/move-hosts';
import {
  HOST_A,
  listAllHosts,
  startMoveSend,
  writeBothHostsConfig,
} from '@impz/e2e-harness/move-steps';
import { registerMoveRemoval } from '@impz/e2e-harness/register-move-removal';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.hostB);

  return { prefix: getSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it shows both hosts in impz ls --all, with the move mark while the imp moves', async () => {
  const ctx = await setupTest();

  const seen = `${ctx.prefix}seen`;

  // The move config keeps B alone, so the listing gets one of its own.
  const configDir = await mkdtemp(join(tmpdir(), 'imp-mv-both-'));

  ctx.stack.defer(() => rm(configDir, { recursive: true, force: true }));

  const bothEnv = await writeBothHostsConfig(ctx.hosts, configDir);

  await runImp('new', seen, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerMoveRemoval(ctx.stack, config.keep, { source: ctx.client, target: ctx.clientB }, seen);

  await waitForExec(seen);
  await runImp('stop', seen);
  await startMoveSend(ctx.hosts.hostA, seen);

  const during = await listAllHosts(bothEnv, seen);

  expect(during.imps.map((imp) => [imp.host, imp.move])).toStrictEqual([[HOST_A, 'sending']]);
  expect(during.rows).toHaveLength(1);
  expect(during.rows[0]).toStartWith(`${HOST_A} `);
  expect(during.rows[0]).toContain(' sending');

  await runImpWith({ env: ctx.hosts.cliEnv }, 'move', seen, HOST_B, '--abort');
  await runImpWith({ env: ctx.hosts.cliEnv }, 'move', seen, HOST_B);

  const after = await listAllHosts(bothEnv, seen);

  expect(after.imps.map((imp) => [imp.host, imp.move])).toStrictEqual([[HOST_B, undefined]]);
  expect(after.rows).toHaveLength(1);
  expect(after.rows[0]).toStartWith(`${HOST_B} `);
  expect(after.rows[0]).not.toContain('sending');
});

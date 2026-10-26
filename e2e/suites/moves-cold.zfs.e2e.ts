import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  createInstanceClient,
  readImp,
  requireImp,
  runImp,
  runImpWith,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec, writeGuestFile } from '@impz/e2e-harness/imps';
import { readImpdLogSince } from '@impz/e2e-harness/instance';
import { HOST_B, readMoveHosts } from '@impz/e2e-harness/move-hosts';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.hostB);

  return { prefix: getSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves a stopped imp cold with its disk and checkpoint, and boots it on the target', async () => {
  const ctx = await setupTest();

  const cold = `${ctx.prefix}cold`;

  await runImp('new', cold, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, cold));

  await waitForExec(cold);
  await writeGuestFile(cold, '/root/moved', 'cold-ok');
  await runImp('checkpoint', cold, 'mv1');
  await runImp('stop', cold);

  const since = new Date();

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', cold, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, cold));

  const left = await readImp(cold);

  expect(out).toContain(`${cold}: moved to ${HOST_B}`);
  expect(left).toBeUndefined();

  // What B received, not what each host runs on: a source that dropped the
  // target's backend would send files between two ZFS hosts.
  const form = process.env['IMP_STORAGE_BACKEND'] === 'zfs' ? 'zfs streams' : 'files';

  const logB = await readImpdLogSince(since, ctx.hosts.hostB);

  expect(logB).toContain(`INFO impd.move imp=${cold} received as ${form}, waiting for the commit`);

  const row = await requireImp(cold, ctx.hosts.hostB);
  const checkpoints = await runImpWith({ target: ctx.hosts.hostB }, 'checkpoints', cold, '--json');

  expect(row.state).toBe('stopped');
  expect(checkpoints).toContain('"mv1"');

  await runImpWith({ target: ctx.hosts.hostB }, 'start', cold);

  const content = await waitFor(`${cold} to boot on B`, () =>
    runImpWith({ target: ctx.hosts.hostB }, 'exec', cold, '--', 'cat', '/root/moved'),
  );

  expect(content).toBe('cold-ok\n');
});

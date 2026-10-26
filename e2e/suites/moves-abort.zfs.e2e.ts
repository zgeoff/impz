import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  assertState,
  createInstanceClient,
  readImp,
  runImp,
  runImpWith,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { HOST_B, readMoveHosts } from '@impz/e2e-harness/move-hosts';
import { startMoveSend } from '@impz/e2e-harness/move-steps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('moves'), stack, hosts, client };
}

test('it leaves an imp where it was on an abort after the source marked it', async () => {
  const ctx = await setupTest();

  const kept = `${ctx.prefix}kept`;

  await runImp('new', kept, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, kept));

  await waitForExec(kept);
  await runImp('stop', kept);
  await startMoveSend(ctx.hosts.hostA, kept);

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', kept, HOST_B, '--abort');
  const onTarget = await readImp(kept, ctx.hosts.hostB);

  expect(out).toContain('move aborted; it stays here');
  expect(onTarget).toBeUndefined();

  await runImp('start', kept);
  await waitFor(`${kept} to boot on A`, () => assertState(kept, 'running'));
});

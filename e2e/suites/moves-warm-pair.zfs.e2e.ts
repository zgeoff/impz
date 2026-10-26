import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  assertState,
  createInstanceClient,
  requireImp,
  runImp,
  runImpWith,
} from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
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

test('it moves two sleeping imps from slots of their own on A onto B side by side, and both wake there', async () => {
  const ctx = await setupTest();

  const first = `${ctx.prefix}pair1`;
  const second = `${ctx.prefix}pair2`;

  await runImp('new', first, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await runImp('new', second, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(first);
  await waitForExec(second);

  const firstOnA = await requireImp(first);
  const secondOnA = await requireImp(second);

  await runImp('sleep', first);
  await runImp('sleep', second);
  await waitFor(`${first} to sleep`, () => assertState(first, 'sleeping'));
  await waitFor(`${second} to sleep`, () => assertState(second, 'sleeping'));

  const firstOut = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', first, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, first));

  const secondOut = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', second, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, second));

  const firstMoved = await requireImp(first, ctx.hosts.hostB);
  const secondMoved = await requireImp(second, ctx.hosts.hostB);

  const onB = { target: ctx.hosts.hostB };

  const firstSaid = await runImpWith(onB, 'exec', first, '--', 'echo', 'pair1-ok');
  const secondSaid = await runImpWith(onB, 'exec', second, '--', 'echo', 'pair2-ok');
  const firstAwake = await requireImp(first, ctx.hosts.hostB);
  const secondAwake = await requireImp(second, ctx.hosts.hostB);

  expect(firstOnA.slot).not.toBe(secondOnA.slot);
  expect(firstOut).toContain(`${first}: moved to ${HOST_B}, asleep with its memory`);
  expect(secondOut).toContain(`${second}: moved to ${HOST_B}, asleep with its memory`);
  expect(firstMoved.state).toBe('sleeping');
  expect(secondMoved.state).toBe('sleeping');
  expect(firstMoved.slot).toBe(firstOnA.slot);
  expect(secondMoved.slot).toBe(secondOnA.slot);
  expect(firstSaid).toBe('pair1-ok\n');
  expect(secondSaid).toBe('pair2-ok\n');
  expect(firstAwake.state).toBe('running');
  expect(secondAwake.state).toBe('running');
  expect(firstAwake.coldBootReason).toBeUndefined();
  expect(secondAwake.coldBootReason).toBeUndefined();
});

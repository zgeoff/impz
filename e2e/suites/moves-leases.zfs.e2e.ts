import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, runImpWith } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { HOST_B, readMoveHosts } from '@impz/e2e-harness/move-hosts';
import { listLeasesOn, sendHostRpc } from '@impz/e2e-harness/move-steps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: 'off' });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.hostB);

  return { prefix: getSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it ends the leases a client took on a stop move, and brings the hold over with its time left', async () => {
  const ctx = await setupTest();

  const leased = `${ctx.prefix}leased`;

  await runImp('new', leased, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, leased));

  await waitForExec(leased);

  const acquired = await sendHostRpc(ctx.hosts.hostA, 'leases/acquire', {
    name: leased,
    label: 'job',
    ttlSeconds: 600,
  });

  await runImp('hold', leased, '30m');

  const refused = await sendHostRpc(ctx.hosts.hostA, 'moves/prepare', {
    name: leased,
    stop: true,
    targetStorage: 'xfs',
  });

  expect(acquired.ok).toBeTrue();
  expect(refused.ok).toBeFalse();
  expect(refused.body).toMatchObject({ code: 'LEASED' });

  const before = Date.now();

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', leased, HOST_B, '--stop');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, leased));

  const after = Date.now();

  const leases = await listLeasesOn(ctx.hosts.hostB, leased);

  expect(out).toContain(`${leased}: moved to ${HOST_B}`);

  expect(leases.map((lease) => [lease.owner.principal, lease.owner.label])).toStrictEqual([
    ['root', 'hold'],
  ]);

  const until = Date.parse(leases[0]?.until ?? '');

  expect(until).toBeGreaterThan(before + 29 * 60_000);
  expect(until).toBeLessThanOrEqual(after + 30 * 60_000);

  // B's root is the hold's owner, so its `hold 0` releases it.
  await runImpWith({ target: ctx.hosts.hostB }, 'hold', leased, '0');

  const released = await listLeasesOn(ctx.hosts.hostB, leased);

  expect(released).toStrictEqual([]);
});

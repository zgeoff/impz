import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, requireImp, runImp, runShellInImp } from '@impz/e2e-harness/imp-cli';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { instance, readImpdLogSince, runCommand, runDevScript } from '@impz/e2e-harness/instance';
import {
  buildGuestIpv6,
  buildV6Names,
  buildV6Plan,
  readGuestIpv6,
  readV6HostAddress,
  startV6Instance,
  startV6Topology,
  stopV6Topology,
} from '@impz/e2e-harness/ipv6-topology';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return {
    prefix: getSuitePrefix('ipv6'),
    stack,
    client,
    plan: buildV6Plan(instance.portOffset),
  };
}

test('it moves a sleeping imp to the routed /64 on a cold boot, and it dials out from its own address there', async () => {
  const ctx = await setupTest();

  const open = `${ctx.prefix}open`;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', open, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  const rebooted = new Date();

  // The reboot sleeps it, and its snapshot holds the old prefix.
  await startV6Instance(ctx.plan, `${ctx.plan.routed}/64`);

  const hostAddress = await readV6HostAddress();

  await runCommand([
    'docker',
    'exec',
    buildV6Names(instance.container).router,
    'ip',
    '-6',
    'route',
    'replace',
    `${ctx.plan.routed}/64`,
    'via',
    hostAddress,
  ]);

  await waitForExec(open);

  const row = await requireImp(open);
  const address = await readGuestIpv6(open);

  const expected = buildGuestIpv6(ctx.plan.routed, row.ip);

  expect(address).toBe(expected);

  const peer = await waitFor('the routed address to reach the server', async () => {
    const seen = await runShellInImp(
      open,
      `wget -q -T 10 -O- http://[${ctx.plan.server}]/cgi-bin/peer`,
    );

    if (seen !== `[${expected}]`) {
      throw new Error(`the server saw ${seen}`);
    }

    return seen;
  });

  const log = await readImpdLogSince(rebooted);

  expect(peer).toBe(`[${expected}]`);
  expect(log).toContain('the IPv6 prefix changed');
});

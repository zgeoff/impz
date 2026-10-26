import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, runShellInImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { instance, runDevScript } from '@impz/e2e-harness/instance';
import {
  buildRaCounterTable,
  buildV6Plan,
  readHostRouting,
  readImpTap,
  readRaCounts,
  readRsAccepts,
  startRaCounter,
  startV6Instance,
  startV6Topology,
  stopRaCounter,
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

test('it ignores a guest’s router advertisement, and still accepts its router solicitation', async () => {
  const ctx = await setupTest();

  const rogue = `${ctx.prefix}ra`;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', rogue, '--image', resolveImageName('e2e-ra'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, rogue));

  await waitForExec(rogue);

  // impd's nft input drops a guest's RA before ip6tables, so a counter on the
  // tap's ingress proves it arrived.
  const tap = await readImpTap(rogue);

  const table = buildRaCounterTable(ctx.prefix);

  await startRaCounter(table, tap);

  ctx.stack.defer(() => stopRaCounter(table));

  const routingBefore = await readHostRouting();

  await runShellInImp(rogue, 'ra-send eth0 2001:db8:66::/64');

  const arrived = await waitFor('the advertisement to reach the tap', async () => {
    const counts = await readRaCounts(table);

    if (!(counts.adverts > 0)) {
      throw new Error(`${String(counts.adverts)} advertisements on ${tap}`);
    }

    return counts;
  });

  const routingAfter = await readHostRouting();
  const acceptsBefore = await readRsAccepts();

  // The guest solicits only while it takes RAs, and the toggle drops its IPv6,
  // so the control comes last.
  await runShellInImp(
    rogue,
    'cd /proc/sys/net/ipv6/conf/eth0 && echo 1 > accept_ra && echo 3 > router_solicitations && echo 1 > disable_ipv6 && echo 0 > disable_ipv6',
  );

  const solicited = await waitFor('a solicitation to reach the host', async () => {
    const counts = await readRaCounts(table);
    const accepts = await readRsAccepts();

    if (!(counts.solicits > arrived.solicits && accepts > acceptsBefore)) {
      throw new Error(
        `${String(counts.solicits)} solicitations on ${tap}, ${String(accepts)} accepted, ${String(acceptsBefore)} before`,
      );
    }

    return { counts, accepts };
  });

  expect(arrived.adverts).toBeGreaterThan(0);
  expect(routingAfter).toBe(routingBefore);
  expect(routingAfter).not.toContain('2001:db8:66');
  expect(solicited.counts.solicits).toBeGreaterThan(arrived.solicits);
  expect(solicited.accepts).toBeGreaterThan(acceptsBefore);
});

import { expect, onTestFinished, test } from 'bun:test';
import { buildReachScript } from '../lib/build-reach-script';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { readContainerGateway } from '../lib/instance';
import {
  LAN,
  readLanConnections,
  runTimedDial,
  startLanNetns,
  stopLanNetns,
} from '../lib/lan-netns';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { startStubPrivateService } from '../lib/start-stub-private-service';
import { getSuitePrefix } from '../lib/suites';
import { waitForTailnetIp } from '../lib/tailnet';
import { writeMetric } from '../lib/write-metric';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const gateway = await readContainerGateway();

  return { prefix: getSuitePrefix('egress'), stack, client, gateway };
}

test('it lets an open imp reach each private listener, before and after a public imp is refused them at once with a reset', async () => {
  const ctx = await setupTest();

  const open = `${ctx.prefix}open`;
  const pub = `${ctx.prefix}pub`;
  const listener = startStubPrivateService(ctx.gateway);

  ctx.stack.defer(() => {
    listener.stop();
  });

  await startLanNetns();

  ctx.stack.defer(() => stopLanNetns());

  await runImp('new', open, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  await runImp(
    'new',
    pub,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'public',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, pub));

  await waitForExec(pub);
  await holdImp(pub);

  // The netns's own start probed each listener once.
  const initial = await readLanConnections();
  const controlLan = await runTimedDial(open, LAN.private, LAN.port);
  const controlGateway = await runTimedDial(open, ctx.gateway, listener.port);
  const beforeRefusals = await readLanConnections();

  const acceptedBefore = listener.readAccepted();

  expect(controlLan.isConnected).toBeTrue();
  expect(controlGateway.isConnected).toBeTrue();
  expect(beforeRefusals[LAN.private]).toBe((initial[LAN.private] ?? 0) + 1);
  expect(acceptedBefore).toBe(1);

  const toGateway = await runTimedDial(pub, ctx.gateway, listener.port);
  const toPrivate = await runTimedDial(pub, LAN.private, LAN.port);
  const toLinkLocal = await runTimedDial(pub, LAN.linkLocal, LAN.port);
  const toMetadata = await runTimedDial(pub, '169.254.169.254', 80);
  const afterRefusals = await readLanConnections();

  const acceptedAfter = listener.readAccepted();
  const refusals = [toGateway, toPrivate, toLinkLocal, toMetadata];

  writeMetric('egressPublicRefusalMs', Math.max(...refusals.map((dial) => dial.durationMs)));

  // A reset at once, where a drop would take all 5 s of nc's -w.
  expect(refusals).toSatisfyAll(
    (dial: (typeof refusals)[number]) =>
      !dial.isConnected && dial.error.includes('Connection refused') && dial.durationMs < 1000,
  );

  expect(afterRefusals).toStrictEqual(beforeRefusals);
  expect(acceptedAfter).toBe(acceptedBefore);

  const againLan = await runTimedDial(open, LAN.private, LAN.port);
  const againGateway = await runTimedDial(open, ctx.gateway, listener.port);

  expect(againLan.isConnected).toBeTrue();
  expect(againGateway.isConnected).toBeTrue();
});

test('it refuses a public imp the host’s tailnet address', async () => {
  const ctx = await setupTest();
  const ip = await waitForTailnetIp();

  const pub = `${ctx.prefix}tail-pub`;

  await runImp(
    'new',
    pub,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'public',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, pub));

  await waitForExec(pub);

  const dial = await runTimedDial(pub, ip, 7070);

  expect(dial.isConnected).toBeFalse();
});

test('it lets a public imp fetch from the internet, and removes a private address from its DNS answers', async () => {
  const ctx = await setupTest();

  const open = `${ctx.prefix}dns-open`;
  const pub = `${ctx.prefix}dns-pub`;

  await runImp('new', open, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  await runImp(
    'new',
    pub,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--policy',
    'public',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, pub));

  await waitForExec(pub);
  await holdImp(pub);

  // A bare exit status hides why a fetch failed in CI, where DNS, the egress rules or the outside
  // host can each refuse it, so the output keeps wget's error and the guest resolver's answer.
  const fetched = await runShellInImp(
    pub,
    `(${buildReachScript('http://example.com/', 5)}) 2>&1; echo "exit $?"; nslookup example.com 2>&1 || true`,
  );

  // sslip.io answers with the address the name spells, here in 10/8: the open
  // imp gets it from the public resolver, and impd removes it from the public
  // imp's answer.
  const openAnswer = await runShellInImp(open, 'nslookup 10-250-77-1.sslip.io 8.8.8.8 || true');
  const publicAnswer = await runShellInImp(pub, 'nslookup 10-250-77-1.sslip.io 8.8.8.8 || true');

  expect(fetched).toStartWith('exit 0\n');
  expect(openAnswer).toContain('10.250.77.1');
  expect(publicAnswer).not.toContain('10.250.77.1');
});

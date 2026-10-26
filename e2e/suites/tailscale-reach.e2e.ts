import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import {
  assertState,
  createInstanceClient,
  readImpUrls,
  readInfo,
  requireImp,
  runImp,
} from '@impz/e2e-harness/imp-cli';
import { holdImp, waitForExec } from '@impz/e2e-harness/imps';
import { runChecked, runInContainer } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import {
  findTailnetNode,
  readMemberBody,
  readMemberStatus,
  readTailnetMember,
  waitForTailnetIp,
} from '@impz/e2e-harness/tailnet';
import { waitFor } from '@impz/e2e-harness/wait-for';
import invariant from 'tiny-invariant';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('tailscale'), stack, client, member: readTailnetMember() };
}

test('it answers tailnet members by IP and by name, and wakes on a tailnet request', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;

  const ip = await waitForTailnetIp();
  const info = await readInfo();
  const status = await readMemberStatus(ctx.member, { runChecked });

  const node = findTailnetNode(Object.values(status.Peer), ip);

  // The host container runs its own tailscaled and still needs public DNS.
  const dns = await runInContainer(['getent', 'hosts', 'pkgs.tailscale.com']);

  expect(ip).toStartWith('100.');
  expect(node).not.toBeNull();
  expect(dns.exitCode).toBe(0);

  invariant(node);

  // The e2e tag, which the tailnet policy keeps away from tag:imp's live impd.
  expect(node.tags).toStrictEqual(['tag:imp-e2e']);

  console.log(`    tailnet host ${String(info.tailscale.hostname)} at ${ip}`);

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const row = await requireImp(name);
  const urls = await readImpUrls(name);

  invariant(urls.tailnet !== null);

  const url = urls.tailnet;

  const byUrl = await waitFor(`${url} over the tailnet`, () => readMemberBody(ctx.member, url));

  const byIpPort = await waitFor(`${ip} port over the tailnet`, () =>
    readMemberBody(ctx.member, `http://${ip}:${String(row.port)}/`),
  );

  const byIpProxy = await waitFor(`${ip} proxy over the tailnet`, () =>
    readMemberBody(ctx.member, `http://${ip}:7080/`, `${name}.imp.localhost`),
  );

  const byFqdnPort = await waitFor(`${node.fqdn} port over the tailnet`, () =>
    readMemberBody(ctx.member, `http://${node.fqdn}:${String(row.port)}/`),
  );

  const byFqdnProxy = await waitFor(`${node.fqdn} proxy over the tailnet`, () =>
    readMemberBody(ctx.member, `http://${node.fqdn}:7080/`, `${name}.imp.localhost`),
  );

  const byShortPort = await waitFor(`${node.short} port over the tailnet`, () =>
    readMemberBody(ctx.member, `http://${node.short}:${String(row.port)}/`),
  );

  const byShortProxy = await waitFor(`${node.short} proxy over the tailnet`, () =>
    readMemberBody(ctx.member, `http://${node.short}:7080/`, `${name}.imp.localhost`),
  );

  expect(byUrl).toBe('e2e-tiny-ok');
  expect(byIpPort).toBe('e2e-tiny-ok');
  expect(byIpProxy).toBe('e2e-tiny-ok');
  expect(byFqdnPort).toBe('e2e-tiny-ok');
  expect(byFqdnProxy).toBe('e2e-tiny-ok');
  expect(byShortPort).toBe('e2e-tiny-ok');
  expect(byShortProxy).toBe('e2e-tiny-ok');

  await runImp('hold', name, '0');
  await runImp('sleep', name);
  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

  const woken = await readMemberBody(ctx.member, url);

  expect(woken).toBe('e2e-tiny-ok');
});

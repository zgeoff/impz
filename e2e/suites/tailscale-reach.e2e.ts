import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  readImpUrls,
  readInfo,
  requireImp,
  runImp,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import {
  findTailnetNode,
  isTailnetReady,
  readLocalTailscaleStatus,
  readTailnetBody,
  requireTailnetReady,
  waitForTailnetIp,
} from '../lib/tailnet';
import { probeTailscaleE2EKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('tailscale'), stack, client };
}

// collection-time gate: Bun 1.4.3's skipIf takes a boolean and has no in-body skip
const tailscaleStatus = await readLocalTailscaleStatus();

// The definition of done needs the tailnet; any other run skips without it.
const tailnetMissing =
  !isTailnetReady(tailscaleStatus, probeTailscaleE2EKey()) && !config.acceptance;

test.skipIf(tailnetMissing)(
  'it answers tailnet members by IP and by name, and wakes on a tailnet request',
  async () => {
    const ctx = await setupTest();
    const status = await readLocalTailscaleStatus();

    requireTailnetReady(status, probeTailscaleE2EKey());
    invariant(status);

    const name = `${ctx.prefix}a`;

    const ip = await waitForTailnetIp();
    const info = await readInfo();

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

    const byUrl = await waitFor(`${url} over the tailnet`, () => readTailnetBody(url));

    const byIpPort = await waitFor(`${ip} port over the tailnet`, () =>
      readTailnetBody(`http://${ip}:${String(row.port)}/`),
    );

    const byIpProxy = await waitFor(`${ip} proxy over the tailnet`, () =>
      readTailnetBody(`http://${ip}:7080/`, `${name}.imp.localhost`),
    );

    const byFqdnPort = await waitFor(`${node.fqdn} port over the tailnet`, () =>
      readTailnetBody(`http://${node.fqdn}:${String(row.port)}/`),
    );

    const byFqdnProxy = await waitFor(`${node.fqdn} proxy over the tailnet`, () =>
      readTailnetBody(`http://${node.fqdn}:7080/`, `${name}.imp.localhost`),
    );

    const byShortPort = await waitFor(`${node.short} port over the tailnet`, () =>
      readTailnetBody(`http://${node.short}:${String(row.port)}/`),
    );

    const byShortProxy = await waitFor(`${node.short} proxy over the tailnet`, () =>
      readTailnetBody(`http://${node.short}:7080/`, `${name}.imp.localhost`),
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

    const woken = await readTailnetBody(url);

    expect(woken).toBe('e2e-tiny-ok');
  },
);

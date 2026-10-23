import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import {
  isTailnetReady,
  readLocalTailscaleStatus,
  requireTailnetReady,
  sendTailnetRpc,
  waitForTailnetIp,
} from '../lib/tailnet';
import { probeTailscaleE2EKey } from '../lib/tailscale-key';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('tailscale'), stack, client };
}

// collection-time gate: Bun's skipIf takes a boolean and has no in-body skip
const tailscaleStatus = await readLocalTailscaleStatus();

// The definition of done needs the tailnet; any other run skips without it.
const tailnetMissing =
  !isTailnetReady(tailscaleStatus, probeTailscaleE2EKey()) && !config.acceptance;

test.skipIf(tailnetMissing)(
  'it lets a tailnet member a rule names reach the API without a token, with that scope only',
  async () => {
    const ctx = await setupTest();
    const status = await readLocalTailscaleStatus();

    requireTailnetReady(status, probeTailscaleE2EKey());

    const name = `${ctx.prefix}rule`;

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);

    const ip = await waitForTailnetIp();
    const whoami = await sendTailnetRpc(ip, 'tokens/whoami', {});
    const stop = await sendTailnetRpc(ip, 'imps/stop', { name });
    const identity: unknown = await whoami.json();

    expect(identity).toMatchObject({ json: { kind: 'tailnet', scope: 'read', imps: null } });
    expect(stop.status).toBe(403);
  },
);

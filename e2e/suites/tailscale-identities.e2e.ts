import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { readTailnetMember, sendMemberRpc, waitForTailnetIp } from '../lib/tailnet';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('tailscale'), stack, client, member: readTailnetMember() };
}

test('it lets a tailnet member a rule names reach the API without a token, with that scope only', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rule`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const ip = await waitForTailnetIp();
  const whoami = await sendMemberRpc(ctx.member, ip, 'tokens/whoami', {});
  const stop = await sendMemberRpc(ctx.member, ip, 'imps/stop', { name });

  const identity: unknown = JSON.parse(whoami.body);

  expect(identity).toMatchObject({ json: { kind: 'tailnet', scope: 'read', imps: null } });
  expect(stop.status).toBe(403);
});

import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { runCommand } from '../lib/instance';
import { makeMemberFetch } from '../lib/make-member-fetch';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { readTailnetMember, waitForTailnetIp } from '../lib/tailnet';

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

  const member = createImpClient({
    url: `http://${ip}:7070`,
    fetch: makeMemberFetch(ctx.member, { runCommand }),
  });

  const identity = await member.tokens.whoami();

  const stop = await member.imps.stop({ name }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(identity).toMatchObject({ kind: 'tailnet', scope: 'read', imps: null });
  expect(stop).toMatchObject({ code: 'FORBIDDEN', status: 403 });
});

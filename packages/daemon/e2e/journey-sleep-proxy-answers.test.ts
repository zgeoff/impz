import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { sendProxyRequest } from '@impz/e2e-harness/http';
import { createInstanceClient, runImp } from '@impz/e2e-harness/imp-cli';
import { waitForExec } from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { openProxySocket } from '@impz/e2e-harness/websocket';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('sleep'), stack, client };
}

test('it answers 404 for an unknown imp, and 502 when nothing in the imp listens', async () => {
  const ctx = await setupTest();

  // e2e-bare serves nothing on the imp's http port.
  const name = `${ctx.prefix}quiet`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const unknown = await sendProxyRequest(`${ctx.prefix}nope`);
  const refused = await sendProxyRequest(name);

  expect(unknown.status).toBe(404);
  expect(refused.status).toBe(502);
  expect(openProxySocket(name)).rejects.toThrow(/closed/u);
});

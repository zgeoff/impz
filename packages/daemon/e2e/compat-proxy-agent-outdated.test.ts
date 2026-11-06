import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, requireImp, runImp } from '@impz/e2e-harness/imp-cli';
import { openHeldSocket, startProxy } from '@impz/e2e-harness/imp-proxy';
import { waitForExec } from '@impz/e2e-harness/imps';
import { instance, runChecked } from '@impz/e2e-harness/instance';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import invariant from 'tiny-invariant';

// One stack for every release, so the agent version comes back and the proxy
// stops before the imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('proxy'), stack, client };
}

test('it reports AGENT_OUTDATED and closes the connection when the imp’s agent is too old to dial', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}old`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const proxy = await startProxy(name, '0:8080');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const imp = await requireImp(name);

  // impd reads the agent's version from the imp's vm.json for each dial.
  const file = `/var/lib/imp/imps/${imp.id}/vm.json`;

  await runChecked([
    instance.containerCLI,
    'exec',
    instance.container,
    'sh',
    '-c',
    `cp ${file} ${file}.e2e && sed -i 's/"agentVersion": "[^"]*"/"agentVersion": "0.1.0"/' ${file}`,
  ]);

  ctx.stack.defer(async () => {
    await runChecked([
      instance.containerCLI,
      'exec',
      instance.container,
      'mv',
      `${file}.e2e`,
      file,
    ]);
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const held = await openHeldSocket(port);

  ctx.stack.defer(() => {
    held.socket.destroy();
  });

  await waitFor('the AGENT_OUTDATED notice', () => {
    expect(proxy.readStderr()).toContain(`impz: ${name}:8080: AGENT_OUTDATED: `);
  });

  await held.closed;

  expect(held.socket.bytesRead).toBe(0);
});

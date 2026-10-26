import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, runShellInImp } from '@impz/e2e-harness/imp-cli';
import {
  PAGE,
  countMatches,
  openHeldSocket,
  readPage,
  sendOverHeldSocket,
  startProxy,
} from '@impz/e2e-harness/imp-proxy';
import type { HeldSocket } from '@impz/e2e-harness/imp-proxy';
import { waitForExec } from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import { waitFor } from '@impz/e2e-harness/wait-for';
import invariant from 'tiny-invariant';

// One stack for every release, so the held connections close and the proxy
// stops before the imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('proxy'), stack, client };
}

test('it refuses only the connection past the tunnel cap with TUNNEL_LIMIT, and opens a tunnel again once the held ones close', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cap`;
  const maxTunnels = 256;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // Each connection is proven before the next opens: a burst past the guest's
  // accept backlog leaves connections that the server never accepts, and the
  // guest drops those about 17 s later.
  await runShellInImp(name, 'setsid nc -lk -p 9100 -e cat >/dev/null 2>&1 &');

  const proxy = await startProxy(name, '0:9100', '0:8080');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const [echoPort, httpPort] = proxy.ports;

  invariant(echoPort !== undefined);
  invariant(httpPort !== undefined);

  const held: HeldSocket[] = [];
  const echoes: string[] = [];

  ctx.stack.defer(() => {
    for (const entry of held) {
      entry.socket.destroy();
    }
  });

  for (let index = 0; index < maxTunnels; index++) {
    const socket = await openHeldSocket(echoPort);

    held.push(socket);

    const echo = await sendOverHeldSocket(socket, 'x');

    echoes.push(echo);
  }

  const extra = await openHeldSocket(echoPort);

  ctx.stack.defer(() => {
    extra.socket.destroy();
  });

  await extra.closed;

  const notices = await waitFor('the TUNNEL_LIMIT notice', () => {
    const count = countMatches(proxy.readStderr(), 'TUNNEL_LIMIT');

    if (count === 0) {
      throw new Error(`impz proxy printed ${proxy.readStderr()}`);
    }

    return count;
  });

  const dropped = held.filter((entry) => entry.socket.destroyed);

  for (const entry of held) {
    entry.socket.destroy();
  }

  const page = await waitFor('a tunnel after the held ones closed', () =>
    readPage(`http://127.0.0.1:${String(httpPort)}/`),
  );

  expect(echoes).toHaveLength(maxTunnels);
  expect(echoes).toSatisfyAll((echo: string) => echo === 'x');
  expect(notices).toBe(1);
  expect(dropped).toBeEmpty();
  expect(page).toBe(PAGE);
});

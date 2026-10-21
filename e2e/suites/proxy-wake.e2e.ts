import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { waitAwakePastIdle } from '../lib/awake-past-idle';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  readState,
  runImp,
  runShellInImp,
} from '../lib/imp-cli';
import {
  GUEST_SERVERS,
  PAGE,
  openHeldSocket,
  readPage,
  sendRequest,
  startProxy,
} from '../lib/imp-proxy';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// One stack for every release, so the proxy stops before its imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('proxy-wake'), stack, client };
}

test('it keeps an imp awake while a proxied connection is open, wakes it on a connection, and drops connections on a forced sleep', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, GUEST_SERVERS);

  const proxy = await startProxy(name, '0:8080', '0:9001', '0:9002');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const [pagePort, heldPort, countPort] = proxy.ports;

  invariant(pagePort !== undefined);
  invariant(heldPort !== undefined);
  invariant(countPort !== undefined);

  const held = await openHeldSocket(heldPort);

  ctx.stack.defer(() => {
    held.socket.destroy();
  });

  const holding = Date.now();

  await waitAwakePastIdle(name, holding);

  held.socket.destroy();

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });

  const started = Date.now();

  const page = await readPage(`http://127.0.0.1:${String(pagePort)}/`);

  writeMetric('proxyWakeMs', Date.now() - started);

  const afterPage = await readState(name);

  expect(page).toBe(PAGE);
  expect(afterPage).toBe('running');

  const dropped = await openHeldSocket(countPort);

  ctx.stack.defer(() => {
    dropped.socket.destroy();
  });

  await runImp('sleep', name);
  await dropped.closed;

  await waitFor('the lost notice', () => {
    if (!proxy.readStderr().includes(`${name}:9002: the connection in the imp was lost`)) {
      throw new Error(`impz proxy said ${proxy.readStderr()}`);
    }
  });

  const reply = await sendRequest(countPort, 'again');
  const afterReply = await readState(name);
  const code = await proxy.stop();

  expect(reply).toBe('got 5 bytes\n');
  expect(afterReply).toBe('running');
  expect(code).toBe(0);
});

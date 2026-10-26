import { expect, onTestFinished, test } from 'bun:test';
import { config } from '@impz/e2e-harness/config';
import { resolveImageName } from '@impz/e2e-harness/fixtures';
import { createInstanceClient, runImp, runShellInImp } from '@impz/e2e-harness/imp-cli';
import {
  GUEST_SERVERS,
  PAGE,
  readPage,
  sendRequest,
  startProxy,
} from '@impz/e2e-harness/imp-proxy';
import { waitForExec } from '@impz/e2e-harness/imps';
import { registerRemoval } from '@impz/e2e-harness/register-removal';
import { removeImpIfPresent } from '@impz/e2e-harness/reset-baseline';
import { getSuitePrefix } from '@impz/e2e-harness/suites';
import invariant from 'tiny-invariant';

// One stack for every release, so the proxy stops before its imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('proxy'), stack, client };
}

test('it forwards a local port on both loopbacks to the http service in the imp', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}lo`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const proxy = await startProxy(name, '0:8080');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const port = String(proxy.ports[0]);

  const overLocalhost = await readPage(`http://localhost:${port}/`);
  const overIpv4 = await readPage(`http://127.0.0.1:${port}/`);
  const overIpv6 = await readPage(`http://[::1]:${port}/`);

  expect(overLocalhost).toBe(PAGE);
  expect(overIpv4).toBe(PAGE);
  expect(overIpv6).toBe(PAGE);
});

test('it forwards to a server that listens on the guest’s loopback only', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}glo`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, GUEST_SERVERS);

  const proxy = await startProxy(name, '0:9001');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const page = await readPage(`http://127.0.0.1:${String(proxy.ports[0])}/`);

  expect(page).toBe(PAGE);
});

test('it delivers the reply to a client that half-closes', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}half`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, GUEST_SERVERS);

  const proxy = await startProxy(name, '0:9002');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const reply = await sendRequest(port, 'hello');

  expect(reply).toBe('got 5 bytes\n');
});

test('it exits 0 when interrupted', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}int`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const proxy = await startProxy(name, '0:8080');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const exitCode = await proxy.stop();

  expect(exitCode).toBe(0);
});

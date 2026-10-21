import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { waitAwakePastIdle } from '../lib/awake-past-idle';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { readThroughProxy } from '../lib/http';
import {
  assertState,
  createInstanceClient,
  readState,
  requireImp,
  runImp,
  runInImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { getSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import {
  openImpPortSocket,
  openProxySocket,
  sendAndRead,
  sendAndReadBinary,
} from '../lib/websocket';
import { writeMetric } from '../lib/write-metric';

// One stack for every release, so each socket closes before its imp goes.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: getSuitePrefix('sleep'), stack, client };
}

test('it relays text and binary both ways, with an early message and a subprotocol', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}relay`;
  const medium = randomBytes(1000);
  const large = randomBytes(100 * 1024);

  await runImp('new', name, '--image', resolveImageName('e2e-ws'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const page = await waitFor(`${name} to serve HTTP`, () => readThroughProxy(name));
  const ws = await openProxySocket(name, ['e2e.v1', 'e2e.v2']);

  ctx.stack.defer(() => {
    ws.socket.close();
  });

  // The server speaks first; the proxy buffers it while it upgrades.
  const greeting = await ws.readMessage();
  const text = await sendAndRead(ws, 'hello');
  const binary = await sendAndReadBinary(ws, new Uint8Array([0, 1, 254, 255]));
  const mediumReply = await sendAndReadBinary(ws, medium);
  const largeReply = await sendAndReadBinary(ws, large);

  ws.socket.close();

  await ws.closed;

  expect(page).toBe('e2e-ws-ok');
  expect(ws.socket.protocol).toBe('e2e.v1');
  expect(greeting).toBe('hello');
  expect(text).toBe('echo hello');
  expect([...binary]).toStrictEqual([...new TextEncoder().encode('echo '), 0, 1, 254, 255]);
  expect(mediumReply).toStrictEqual(Buffer.concat([Buffer.from('echo '), medium]));
  expect(largeReply).toStrictEqual(Buffer.concat([Buffer.from('echo '), large]));
});

test('it carries close codes and reasons across the proxy both ways', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}close`;

  await runImp('new', name, '--image', resolveImageName('e2e-ws'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const page = await waitFor(`${name} to serve HTTP`, () => readThroughProxy(name));
  const fromServer = await openProxySocket(name);

  ctx.stack.defer(() => {
    fromServer.socket.close();
  });

  await fromServer.readMessage();

  fromServer.socket.send('close 4001 server-bye');

  const serverClose = await fromServer.closed;
  const fromClient = await openProxySocket(name);

  ctx.stack.defer(() => {
    fromClient.socket.close();
  });

  await fromClient.readMessage();

  fromClient.socket.close(4002, 'client-bye');

  await fromClient.closed;

  const seen = await waitFor('the server to see the client close', async () => {
    const last = await runInImp(name, 'cat', '/tmp/ws-last-close');

    // The server's own close may be the one it wrote first.
    if (last !== '4002 client-bye') {
      throw new Error(`the last close it saw: ${last}`);
    }

    return last;
  });

  expect(page).toBe('e2e-ws-ok');
  expect(serverClose).toStrictEqual({ code: 4001, reason: 'server-bye' });
  expect(seen).toBe('4002 client-bye');
});

test("it relays WebSockets on the imp's own port too", async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}port`;

  await runImp('new', name, '--image', resolveImageName('e2e-ws'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const page = await waitFor(`${name} to serve HTTP`, () => readThroughProxy(name));
  const row = await requireImp(name);
  const ws = await openImpPortSocket(row.slot);

  ctx.stack.defer(() => {
    ws.socket.close();
  });

  const greeting = await ws.readMessage();
  const text = await sendAndRead(ws, 'by port');

  ws.socket.close();

  await ws.closed;

  expect(page).toBe('e2e-ws-ok');
  expect(greeting).toBe('hello');
  expect(text).toBe('echo by port');
});

test('it keeps an imp awake while a WebSocket is open, and wakes it on an upgrade once it slept', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}awake`;

  await runImp('new', name, '--image', resolveImageName('e2e-ws'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const page = await waitFor(`${name} to serve HTTP`, () => readThroughProxy(name));
  const held = await openProxySocket(name);

  ctx.stack.defer(() => {
    held.socket.close();
  });

  await held.readMessage();

  const openFrom = Date.now();

  await waitAwakePastIdle(name, openFrom);

  const still = await sendAndRead(held, 'still here');

  held.socket.close();

  await held.closed;

  expect(still).toBe('echo still here');

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });

  const upgrading = Date.now();

  const woken = await openProxySocket(name);

  ctx.stack.defer(() => {
    woken.socket.close();
  });

  const greeting = await woken.readMessage();

  writeMetric('wakeOnWebSocketMs', Date.now() - upgrading);

  const text = await sendAndRead(woken, 'woken');
  const state = await readState(name);

  woken.socket.close();

  await woken.closed;

  expect(page).toBe('e2e-ws-ok');
  expect(greeting).toBe('hello');
  expect(text).toBe('echo woken');
  expect(state).toBe('running');
});

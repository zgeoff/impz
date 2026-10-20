import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { listApiCalls } from '../../src/db/api-audit';
import { createImage } from '../../src/db/images';
import { readImpByName } from '../../src/db/imps';
import { buildImagePaths, buildImpPaths } from '../../src/storage/data-layout';
import { buildMockNewImage } from '../imps/build-mock-new-image';
import { buildQueryGate } from '../platform/build-query-gate';
import { startTestImpd } from '../start-test-impd';
import { TEST_TOKEN } from '../test-token';
import { buildStubExecGuest } from '../vm/build-stub-exec-guest';
import { startStubExecAgent } from '../vm/start-stub-exec-agent';
import { buildImpdSocketUrl, tryExecSocket, tryTunnelSocket } from './try-impd-sockets';

// impd's real app on a loopback port, as the clients reach it, and a root
// client for the scenario; an armed `gate` holds impd's next read of the
// imps until the test releases it
async function setupTest() {
  // first, so a held read lets go before impd stops
  const gate = buildQueryGate('imps');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { wrapDatabase: gate.wrap });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // the image every imps.create boots when it names none
  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  // assigned, not spread: a spread reads the harness's parts once
  return Object.assign(harness, {
    gate,
    port: new URL(harness.url).port,
    client: createImpClient({ url: harness.url, token: TEST_TOKEN }),
    stack,
  });
}

test('#tryExecSocket sends a start for the name and returns the first message', async () => {
  const ctx = await setupTest();

  const reply = await tryExecSocket(ctx.port, '', 'dev-a', {
    authorization: `Bearer ${TEST_TOKEN}`,
  });

  expect(reply).toBe(
    '{"type":"error","code":"NOT_FOUND","message":"imp dev-a not found","data":{"kind":"imp","name":"dev-a"}}',
  );
});

test('#tryExecSocket starts dev when no name is given', async () => {
  const ctx = await setupTest();

  const reply = await tryExecSocket(ctx.port, '', undefined, {
    authorization: `Bearer ${TEST_TOKEN}`,
  });

  expect(reply).toBe(
    '{"type":"error","code":"NOT_FOUND","message":"imp dev not found","data":{"kind":"imp","name":"dev"}}',
  );
});

test('#tryExecSocket opens /exec with the query', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const issued = await ctx.client.exec.ticket({ name: 'dev' });
  const reply = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`, 'other');

  // past the upgrade on the ticket, refused at start: it names another imp
  expect(reply).toBe(
    '{"type":"error","code":"FORBIDDEN","message":"the exec ticket is for imp dev"}',
  );
});

test('#tryExecSocket returns rejected when the upgrade is refused', async () => {
  const ctx = await setupTest();
  const reply = await tryExecSocket(ctx.port, '');

  expect(reply).toBe('rejected');
});

test('#tryExecSocket returns closed when the server closes without a message', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });

  ctx.gate.arm();

  const trying = tryExecSocket(ctx.port, '', 'dev', { authorization: `Bearer ${made.secret}` });

  await ctx.gate.reached;

  // impd closes the socket of a token removed while its start waits
  await ctx.client.tokens.delete({ name: 'agent' });

  const reply = await trying;

  expect(reply).toBe('closed');
});

test('#tryTunnelSocket sends an open for the name and returns the first message', async () => {
  const ctx = await setupTest();

  const reply = await tryTunnelSocket(
    ctx.port,
    '',
    { authorization: `Bearer ${TEST_TOKEN}` },
    'db',
  );

  expect(reply).toBe('{"type":"error","code":"NOT_FOUND","message":"imp db not found"}');
});

test('#tryTunnelSocket opens the tunnel on port 5432', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await tryTunnelSocket(ctx.port, '', { authorization: `Bearer ${TEST_TOKEN}` }, 'dev');

  // the audit row lands after the open settles
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, 'dev', 10, null);

    return listed.some((call) => call.procedure.startsWith('tunnel:')) ? listed : null;
  });

  expect(calls).toPartiallyContain({ procedure: 'tunnel:5432' });
});

test('#tryTunnelSocket opens nope when no name is given', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', { authorization: `Bearer ${TEST_TOKEN}` });

  expect(reply).toBe('{"type":"error","code":"NOT_FOUND","message":"imp nope not found"}');
});

test('#tryTunnelSocket returns rejected when the upgrade is refused', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', {});

  expect(reply).toBe('rejected');
});

test('#tryTunnelSocket returns closed when the server closes without a message', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });

  ctx.gate.arm();

  const trying = tryTunnelSocket(ctx.port, '', { authorization: `Bearer ${made.secret}` }, 'dev');

  await ctx.gate.reached;

  // impd closes the socket of a token removed while its open waits
  await ctx.client.tokens.delete({ name: 'agent' });

  const reply = await trying;

  expect(reply).toBe('closed');
});

test('#tryExecSocket starts true without a terminal', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'dev' });

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await tryExecSocket(ctx.port, '', 'dev', { authorization: `Bearer ${TEST_TOKEN}` });

  expect(guest.requests).toStrictEqual([{ argv: ['true'], tty: false }]);
});

test('#buildImpdSocketUrl opens /exec on the loopback port with the query', () => {
  expect(buildImpdSocketUrl('7070', '/exec', 'ticket=abc')).toBe(
    'ws://127.0.0.1:7070/exec?ticket=abc',
  );
});

test('#buildImpdSocketUrl opens /tunnel on the loopback port with the query', () => {
  expect(buildImpdSocketUrl('7070', '/tunnel', 'ticket=abc')).toBe(
    'ws://127.0.0.1:7070/tunnel?ticket=abc',
  );
});

import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { openReverseForward } from '@impz/client';
import { TEST_TOKEN, startTestImpd } from '@impz/testing';
import { waitFor } from '@zgeoff/testing';
import type { TestImpdOptions } from '../types';

async function setupTest(options: TestImpdOptions = {}) {
  const impd = await startTestImpd(options);

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');
  await impd.client.imps.create({ name: 'box', image: 'ubuntu' });

  const openSocket = async (path: string, baseUrl = impd.url) => {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${path}`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    const messages: string[] = [];
    const pongs: string[] = [];
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    const opened = Promise.withResolvers<void>();

    socket.addEventListener('open', () => {
      opened.resolve();
    });

    socket.addEventListener('message', (event) => {
      messages.push(String(event.data));
    });

    socket.addEventListener('pong', (event) => {
      pongs.push(String(event.data));
    });

    socket.addEventListener('close', (event) => {
      closed.resolve({ code: event.code, reason: event.reason });
    });

    await opened.promise;

    return { socket, messages, pongs, closed: closed.promise };
  };

  const observeUnauthorizedHandshake = async (through: 'impd' | 'proxy'): Promise<string[]> => {
    const baseUrl = through === 'impd' ? impd.impdUrl : impd.url;

    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/exec`, {
      headers: { authorization: 'Bearer wrong-token' },
    });

    const events: string[] = [];
    const closed = Promise.withResolvers<void>();

    socket.addEventListener('open', () => {
      events.push('open');
    });

    socket.addEventListener('error', () => {
      events.push('error');
    });

    socket.addEventListener('close', (event) => {
      events.push(`close:${String(event.code)}`);
      closed.resolve();
    });

    await closed.promise;

    return events;
  };

  return { impd, openSocket, observeUnauthorizedHandshake };
}

test('it answers a call as it does with no fault set', async () => {
  const ctx = await setupTest();
  const imps = await ctx.impd.client.imps.list();
  const direct = await fetch(`${ctx.impd.impdUrl}/health`);
  const proxied = await fetch(`${ctx.impd.url}/health`);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['box']);
  expect([direct.status, proxied.status]).toStrictEqual([200, 200]);
  expect(ctx.impd.url).not.toBe(ctx.impd.impdUrl);
});

test('it refuses one call with a defined error and lets the next reach impd', async () => {
  const ctx = await setupTest();

  ctx.impd.fail('imps/sleep', { code: 'CONFLICT', status: 409, message: 'busy' }, { times: 1 });

  const refused = ctx.impd.client.imps.sleep({ name: 'box' });

  expect(refused).rejects.toMatchObject({
    code: 'CONFLICT',
    status: 409,
    message: 'busy',
    defined: true,
  });

  const slept = await ctx.impd.client.imps.sleep({ name: 'box' });

  expect(slept.name).toBe('box');
});

test('it narrows a fault to the calls whose input the predicate accepts', async () => {
  const ctx = await setupTest();

  await ctx.impd.client.imps.create({ name: 'other', image: 'ubuntu' });

  ctx.impd.fail(
    'imps/sleep',
    { code: 'CONFLICT', status: 409 },
    {
      when: (input) =>
        typeof input === 'object' && input !== null && 'name' in input && input.name === 'box',
    },
  );

  const refused = ctx.impd.client.imps.sleep({ name: 'box' });

  expect(refused).rejects.toMatchObject({ code: 'CONFLICT' });

  const slept = await ctx.impd.client.imps.sleep({ name: 'other' });

  expect(slept.name).toBe('other');
});

test('it answers a raw body that is no oRPC error', async () => {
  const ctx = await setupTest();

  ctx.impd.fail('imps/list', { status: 500, body: { message: 'boom' } });

  expect(ctx.impd.client.imps.list()).rejects.toMatchObject({ defined: false, status: 500 });
});

test('it stops answering a call once the fault is cleared', async () => {
  const ctx = await setupTest();

  const fault = ctx.impd.fail('imps/list', { code: 'CONFLICT', status: 409 });

  fault.clear();

  const afterClear = await ctx.impd.client.imps.list();

  ctx.impd.fail('imps/list', { code: 'CONFLICT', status: 409 });
  ctx.impd.clearFaults();

  const afterClearAll = await ctx.impd.client.imps.list();

  expect([afterClear.length, afterClearAll.length]).toStrictEqual([1, 1]);
});

test('it keeps a stalled call pending until its signal aborts', async () => {
  const ctx = await setupTest();

  const abort = new AbortController();

  const outcome = { settled: false };

  ctx.impd.stall('imps/list');

  const call = ctx.impd.client.imps.list(undefined, { signal: abort.signal });

  const watched = (async () => {
    await call.catch(() => {});

    outcome.settled = true;
  })();

  await waitFor(() => {
    expect(ctx.impd.calls.at(-1)?.procedure).toBe('imps/list');
  });

  const settledBeforeAbort = outcome.settled;

  abort.abort();

  await watched;

  expect([settledBeforeAbort, outcome.settled]).toStrictEqual([false, true]);
});

test('it ends an open tunnel socket with code 1006 when it drops connections', async () => {
  const ctx = await setupTest();
  const tunnel = await ctx.openSocket('/tunnel');

  ctx.impd.dropConnections();

  const closed = await tunnel.closed;

  expect(closed.code).toBe(1006);
});

test('it ends an open exec socket with code 1006 when it drops connections', async () => {
  const ctx = await setupTest();
  const exec = await ctx.openSocket('/exec');

  ctx.impd.dropConnections();

  const closed = await exec.closed;

  expect(closed.code).toBe(1006);
});

test('it ends a call in flight when it drops connections', async () => {
  const ctx = await setupTest();

  ctx.impd.stall('imps/list');

  const call = ctx.impd.client.imps.list();

  await waitFor(() => {
    expect(ctx.impd.calls.at(-1)?.procedure).toBe('imps/list');
  });

  ctx.impd.dropConnections();

  expect(call).rejects.toThrow();
});

test('it holds a call while frozen and answers it after thaw', async () => {
  const ctx = await setupTest();

  const outcome = { imps: 0 };

  ctx.impd.freeze();

  const call = ctx.impd.client.imps.list();

  const watched = (async () => {
    const imps = await call;

    outcome.imps = imps.length;
  })();

  await waitFor(() => {
    expect(ctx.impd.calls.at(-1)?.procedure).toBe('imps/list');
  });

  const heldBeforeThaw = outcome.imps;

  ctx.impd.thaw();

  await watched;

  expect([heldBeforeThaw, outcome.imps]).toStrictEqual([0, 1]);
});

test('it holds a socket message while frozen and delivers it after thaw', async () => {
  const ctx = await setupTest();
  const exec = await ctx.openSocket('/exec');

  ctx.impd.freeze();
  exec.socket.send('not json');

  const heldBeforeThaw = [...exec.messages];

  ctx.impd.thaw();

  await waitFor(() => {
    expect(exec.messages).toHaveLength(1);
  });

  expect(heldBeforeThaw).toStrictEqual([]);
  expect(JSON.parse(exec.messages[0] ?? '')).toMatchObject({ type: 'error' });
});

test.each(['/exec', '/tunnel'])(
  'it holds a ping on a %s socket while frozen and answers it after thaw',
  async (path) => {
    const ctx = await setupTest();
    const ws = await ctx.openSocket(path);
    const direct = await ctx.openSocket(path, ctx.impd.impdUrl);

    ctx.impd.freeze();
    ws.socket.ping('held');

    // five ping round trips to impd itself, each one hop shorter than a pong from the proxy
    for (const count of [1, 2, 3, 4, 5]) {
      direct.socket.ping();

      await waitFor(() => {
        expect(direct.pongs).toHaveLength(count);
      });
    }

    const pongsBeforeThaw = [...ws.pongs];

    ctx.impd.thaw();
    ws.socket.ping('after');

    await waitFor(() => {
      expect(ws.pongs).toHaveLength(2);
    });

    expect(pongsBeforeThaw).toStrictEqual([]);
    expect(ws.pongs).toStrictEqual(['held', 'after']);
  },
);

test('it answers a ping once after a second thaw', async () => {
  const ctx = await setupTest();
  const tunnel = await ctx.openSocket('/tunnel');

  ctx.impd.freeze();
  ctx.impd.thaw();
  ctx.impd.thaw();
  tunnel.socket.ping('once');

  await waitFor(() => {
    expect(tunnel.pongs).toHaveLength(1);
  });

  // a round trip to impd itself, which takes longer than a second copy of the pong
  await fetch(`${ctx.impd.impdUrl}/health`);

  expect(tunnel.pongs).toStrictEqual(['once']);
});

test('it answers the next exec socket with the error frame and closes it', async () => {
  const ctx = await setupTest();

  ctx.impd.refuseExec({
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready',
    data: { reason: 'broker_not_ready' },
  });

  const exec = await ctx.openSocket('/exec');
  const closed = await exec.closed;

  expect(exec.messages.map((message): unknown => JSON.parse(message))).toStrictEqual([
    {
      type: 'error',
      code: 'PRECONDITION_FAILED',
      message: 'the broker is not ready',
      data: { reason: 'broker_not_ready' },
    },
  ]);

  expect(closed.code).toBe(1000);
});

test('it ends a reverse forward with the code and reason it closes tunnels with', async () => {
  const ctx = await setupTest();

  await ctx.impd.startGuest('box');

  const forward = openReverseForward({
    baseUrl: ctx.impd.url,
    token: TEST_TOKEN,
    name: 'box',
    guest: { network: 'tcp', port: 4000 },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.impd.closeTunnels(4001, 'tunnel gone');

  expect(forward.ended).resolves.toStrictEqual({
    kind: 'closed',
    code: 4001,
    reason: 'tunnel gone',
  });
});

test('it reports the version that the test sets and merges the features', async () => {
  const ctx = await setupTest({ version: '2.1.0', features: { leases: false } });
  const info = await ctx.impd.client.system.info();
  const features = await ctx.impd.client.system.features();

  expect(info.version).toBe('2.1.0');
  expect(features).toMatchObject({ version: '2.1.0', features: { leases: false } });
});

test('it records each call with its procedure, input and token', async () => {
  const ctx = await setupTest();

  const before = ctx.impd.calls.length;

  await ctx.impd.client.imps.get({ name: 'box' });

  expect(ctx.impd.calls.slice(before)).toStrictEqual([
    { procedure: 'imps/get', input: { name: 'box' }, authorization: `Bearer ${TEST_TOKEN}` },
  ]);
});

test('it rejects an unauthorized socket handshake as impd does', async () => {
  const ctx = await setupTest();
  const direct = await ctx.observeUnauthorizedHandshake('impd');
  const proxied = await ctx.observeUnauthorizedHandshake('proxy');

  expect(direct).not.toContain('open');
  expect(proxied).toStrictEqual(direct);
});

test('it holds an injected answer while frozen and sends it after thaw', async () => {
  const ctx = await setupTest();

  const outcome = { settled: false };

  ctx.impd.fail('imps/list', { code: 'CONFLICT', status: 409 });
  ctx.impd.freeze();

  const call = ctx.impd.client.imps.list();

  const watched = (async () => {
    await call.catch(() => {});

    outcome.settled = true;
  })();

  await waitFor(() => {
    expect(ctx.impd.calls.at(-1)?.procedure).toBe('imps/list');
  });

  // a round trip to impd itself, which takes longer than the proxy needs to answer
  await fetch(`${ctx.impd.impdUrl}/health`);

  const settledBeforeThaw = outcome.settled;

  ctx.impd.thaw();

  await watched;

  expect(call).rejects.toMatchObject({ code: 'CONFLICT' });
  expect([settledBeforeThaw, outcome.settled]).toStrictEqual([false, true]);
});

test('it keeps a connection alive between calls and destroys it on dropConnections', async () => {
  const ctx = await setupTest();

  const socket = connect({ host: '127.0.0.1', port: Number(new URL(ctx.impd.url).port) });

  onTestFinished(() => {
    socket.destroy();
  });

  const received: string[] = [];
  const closed = Promise.withResolvers<void>();

  socket.on('data', (chunk) => {
    received.push(String(chunk));
  });

  socket.on('close', () => {
    closed.resolve();
  });

  const request = 'GET /health HTTP/1.1\r\nHost: impd\r\nConnection: keep-alive\r\n\r\n';

  socket.write(request);

  await waitFor(() => {
    expect(received.join('').split('200 OK')).toHaveLength(2);
  });

  socket.write(request);

  await waitFor(() => {
    expect(received.join('').split('200 OK')).toHaveLength(3);
  });

  expect(socket.destroyed).toBe(false);

  ctx.impd.dropConnections();

  await closed.promise;

  expect(socket.destroyed).toBe(true);
});

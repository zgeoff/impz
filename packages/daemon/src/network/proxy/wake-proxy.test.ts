import { expect, jest, mock, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { startStubBrokerSocketUpstream } from '../../../testing/network/start-stub-broker-socket-upstream';
import { startStubCutStream } from '../../../testing/network/start-stub-cut-stream';
import { startStubHeaderEcho } from '../../../testing/network/start-stub-header-echo';
import { startStubPausedSocketGuest } from '../../../testing/network/start-stub-paused-socket-guest';
import { startStubSilentOrigin } from '../../../testing/network/start-stub-silent-origin';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { startTestImpd } from '../../../testing/start-test-impd';
import { removeImp, updateImpMove } from '../../platform/db/imps';
import { PEER_HEADER, createForwardedPeers } from './forwarded-peers';
import { startWakeProxy } from './wake-proxy';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  // assigned, not spread: a spread reads the harness's parts once
  return Object.assign(harness, { stack });
}

test('it ends overlapping listener syncs with no listener for an imp the database lost', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const old = await ctx.impd.imps.createImp({ name: 'old' });

  await proxy.syncListeners();

  await removeImp(ctx.db, old.id);

  const fresh = await ctx.impd.imps.createImp({ name: 'new' });

  const first = proxy.syncListeners();

  await removeImp(ctx.db, fresh.id);

  const second = proxy.syncListeners();

  await Promise.all([first, second]);

  expect(proxy.readImpPort(fresh.id)).toBeNull();
});

test('it listens on the proxy port and on the port base plus each imp’s slot by default', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const free = claimFreePorts(2);
  const proxyPort = free.take();
  const portBase = free.take();

  const proxy = startWakeProxy({
    config: { ...ctx.config, proxyPort, portBase },
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/`, {
    headers: { host: 'localhost' },
  });

  await response.text();

  expect(proxy.port).toBe(proxyPort);
  expect(proxy.readImpPort(imp.id)).toBe(portBase + imp.slot);
  expect(response.status).toBe(404);
});

test('it stops the listener of an imp the database lost', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await proxy.syncListeners();

  const port = proxy.readImpPort(imp.id);

  invariant(port !== null);

  await removeImp(ctx.db, imp.id);

  await proxy.syncListeners();

  expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow();
});

test('it keeps the dashboard session cookie from an imp over HTTP', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const cookies: (string | null)[] = [];

  const handleUpstreamRequest = (request: Request) => {
    cookies.push(request.headers.get('cookie'));

    return new Response('ok');
  };

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleUpstreamRequest,
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret; __Host-imp_session=v1.2.secret; b=2' },
  });

  await response.text();

  expect(cookies).toStrictEqual(['a=1; b=2']);
});

test('it keeps the dashboard session cookie from an imp over a WebSocket', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const cookies: (string | null)[] = [];

  const handleUpstreamRequest = (request: Request, server: Bun.Server<undefined>) => {
    cookies.push(request.headers.get('cookie'));

    return server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
  };

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleUpstreamRequest,
    websocket: { message: () => {} },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const socket = new WebSocket(`ws://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret' },
  });

  onTestFinished(() => {
    socket.close();
  });

  const opened = await new Promise<string>((resolve) => {
    socket.addEventListener('open', () => {
      resolve('open');
    });

    socket.addEventListener('error', () => {
      resolve('error');
    });
  });

  expect(opened).toBe('open');
  expect(cookies).toStrictEqual(['a=1']);
});

test('it closes a WebSocket whose client stops reading once the backlog passes 16 MiB', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: join(ctx.config.dataDir, 'socket-upstream'),
    isPlain: true,
  });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const port = proxy.readImpPort(imp.id);

  invariant(port !== null);

  const client = await startStubPausedSocketGuest(ctx.stack, {
    port,
    host: `127.0.0.1:${String(port)}`,
    path: '/',
  });

  await waitFor(() => {
    expect(upstream.sockets).toHaveLength(1);
  });

  const chunk = Buffer.alloc(1024 * 1024, 7);

  // one MiB each poll: the service's own buffer drops what the proxy has
  // not taken yet, so it sends until the proxy closes
  await waitFor(() => {
    upstream.sockets[0]?.send(chunk);
    expect(upstream.closes).toHaveLength(1);
  });

  client.resume();

  await client.closed;

  expect(client.head).toStartWith('HTTP/1.1 101 ');
});

test('it relays WebSocket messages both ways', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = startStubHeaderEcho(ctx.stack);

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const socket = new WebSocket(`ws://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  onTestFinished(() => {
    socket.close();
  });

  const reply = new Promise<string>((resolve) => {
    socket.addEventListener('message', (event) => {
      resolve(String(event.data));
    });
  });

  await new Promise((resolve) => {
    socket.addEventListener('open', resolve);
  });

  socket.send('hello');

  const echoed = await reply;

  expect(echoed).toBe('hello');
});

test.each([['/ui/'], ['/ui/assets/app.js'], ['/health'], ['/rpcx']])(
  'it hands the API no peer handle, and strips a forged one, on %s',
  async (path) => {
    const ctx = await setupTest();

    const seen: (string | null)[] = [];

    const handleApiRequest = (request: Request) => {
      seen.push(request.headers.get(PEER_HEADER));

      return new Response('ok');
    };

    const api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: handleApiRequest,
    });

    ctx.stack.defer(() => api.stop(true));

    const register = mock(() => 'handle');

    const proxy = startWakeProxy({
      config: { ...ctx.config, apiPort: api.port ?? 0 },
      db: ctx.db,
      imps: ctx.impd.imps,
      peers: { register, take: () => null },
      ports: { proxy: 0, slot: () => 0 },
    });

    ctx.stack.defer(() => proxy.stop());

    const apex = proxy.startListener({
      port: 0,
      hostname: '127.0.0.1',
      route: () => ({ kind: 'api' }),
    });

    ctx.stack.defer(() => apex.stop(true));

    const response = await fetch(`http://127.0.0.1:${String(apex.port)}${path}`, {
      headers: { [PEER_HEADER]: 'forged' },
    });

    await response.text();

    expect(seen).toStrictEqual([null]);
    expect(register).not.toHaveBeenCalled();
  },
);

test('it hands the API a peer handle for the client’s address on a path that resolves a caller', async () => {
  const ctx = await setupTest();

  const seen: (string | null)[] = [];

  const handleApiRequest = (request: Request) => {
    seen.push(request.headers.get(PEER_HEADER));

    return new Response('ok');
  };

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleApiRequest,
  });

  ctx.stack.defer(() => api.stop(true));

  const register = mock<(address: string) => string>(() => 'handle');

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: { register, take: () => null },
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(apex.port)}/rpc/system/info`, {
    method: 'POST',
    headers: { [PEER_HEADER]: 'forged' },
  });

  await response.text();

  expect(seen).toStrictEqual(['handle']);
  expect(register).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/127\.0\.0\.1$/v));
});

test('it passes the first line of a streamed API answer on while the API holds the next', async () => {
  const ctx = await setupTest();

  const second = Promise.withResolvers<void>();

  onTestFinished(() => {
    second.resolve();
  });

  const handleApiRequest = () => {
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        controller.enqueue(new TextEncoder().encode('first\n'));

        await second.promise;

        controller.enqueue(new TextEncoder().encode('second\n'));
        controller.close();
      },
    });

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleApiRequest,
  });

  ctx.stack.defer(() => api.stop(true));

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(apex.port)}/rpc/images/buildStream`, {
    method: 'POST',
    body: 'tar',
  });

  invariant(response.body);

  const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();

  const first = await lines.read();

  expect(first.value).toBe('first\n');
});

// Bun reads its fetch idle limit (360 s by default) only at startup, so the
// proxy runs in a child Bun with 1 s; the child's plain fetch is the control
// that the limit expires, after about 8 s
test('it passes on an API answer that stays silent past Bun’s idle limit, where a plain fetch gives up', async () => {
  const ctx = await setupTest();

  const origin = startStubSilentOrigin(ctx.stack);

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../../../testing/surface/run-idle-limited-requests.ts'),
      JSON.stringify({ origin: origin.origin, via: 'wake-proxy' }),
    ],
    {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  ctx.stack.defer(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  const lines = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(lines).toIncludeSameMembers([
    { kind: 'control', isOk: false, error: 'TimeoutError' },
    { kind: 'long', isOk: true, status: 200, body: 'the long answer' },
  ]);
  // oxlint-disable-next-line zgeoff/max-test-timeout -- 8.2 s on CI; floor: Bun's fetch idle limit fires at 8.0 s for BUN_CONFIG_HTTP_IDLE_TIMEOUT 1 or 2, and a fraction turns it off
}, 16_000);

test('it passes on an API answer that comes after 400 s of fake time', async () => {
  const ctx = await setupTest();

  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  onTestFinished(() => {
    release.resolve(undefined);
  });

  const handleApiRequest = async () => {
    held.resolve(undefined);

    await release.promise;

    return new Response('the long answer');
  };

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: handleApiRequest,
  });

  ctx.stack.defer(() => api.stop(true));

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));
  jest.useFakeTimers();

  onTestFinished(() => {
    jest.useRealTimers();
  });

  // the client's own hop lifts Bun's limit, so only the proxy is under test
  const call = fetch(`http://127.0.0.1:${String(apex.port)}/rpc/backups/run`, {
    method: 'POST',
    body: '{}',
    timeout: false,
  });

  await held.promise;

  jest.advanceTimersByTime(400_000);
  jest.useRealTimers();
  release.resolve(undefined);

  const response = await call;
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(text).toBe('the long answer');
});

test('it passes the rest of a streamed API answer on once the API sends it', async () => {
  const ctx = await setupTest();

  const second = Promise.withResolvers<void>();

  const handleApiRequest = () => {
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        controller.enqueue(new TextEncoder().encode('first\n'));

        await second.promise;

        controller.enqueue(new TextEncoder().encode('second\n'));
        controller.close();
      },
    });

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleApiRequest,
  });

  ctx.stack.defer(() => api.stop(true));

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(apex.port)}/rpc/images/buildStream`, {
    method: 'POST',
    body: 'tar',
  });

  second.resolve();

  const body = await response.text();

  expect(body).toBe('first\nsecond\n');
});

test.each([['box.tail1234.ts.net'], ['imp.example.com'], ['imp.tail1234.ts.net']])(
  'it sends a request on an imp’s port to the imp, not the API, for Host %s',
  async (host) => {
    const ctx = await setupTest();

    await ctx.createTestImage('ubuntu');

    const toApi = mock();

    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: {
        '/*': (request: Request) => new Response(`imp got ${request.headers.get('host') ?? ''}`),
      },
    });

    ctx.stack.defer(() => upstream.stop(true));

    const handleApiRequest = () => {
      toApi();

      return new Response('api');
    };

    const api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: handleApiRequest,
    });

    ctx.stack.defer(() => api.stop(true));

    const proxy = startWakeProxy({
      config: { ...ctx.config, apiPort: api.port ?? 0 },
      db: ctx.db,
      imps: ctx.impd.imps,
      peers: createForwardedPeers(Date.now),
      ports: { proxy: 0, slot: () => 0 },
    });

    ctx.stack.defer(() => proxy.stop());

    const imp = await ctx.impd.imps.createImp({ name: 'box', httpPort: upstream.port });

    await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
    await proxy.syncListeners();

    const response = await fetch(
      `http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/rpc/system/info`,
      { method: 'POST', headers: { host } },
    );

    const body = await response.text();

    expect(body).toBe(`imp got ${host}`);
    expect(toApi).not.toHaveBeenCalled();
  },
);

test('it passes tailscale serve’s headers on to the imp, with the session and peer handle stripped', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const received: Headers[] = [];

  const handleUpstreamRequest = (request: Request) => {
    received.push(request.headers);

    return new Response('imp');
  };

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleUpstreamRequest,
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'box', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`, {
    headers: {
      host: 'box.tail1234.ts.net',
      'x-forwarded-for': '100.101.1.2',
      'x-forwarded-proto': 'https',
      'tailscale-user-login': 'alice@example.com',
      cookie: 'a=1; imp_session=v1.2.secret',
      [PEER_HEADER]: 'forged',
    },
  });

  await response.text();

  const [headers] = received;

  invariant(headers);

  expect(headers.get('x-forwarded-host')).toBe('box.tail1234.ts.net');

  expect(headers.get('x-forwarded-for')).toMatch(
    /^100\.101\.1\.2, (?<v4mapped>::ffff:)?127\.0\.0\.1$/v,
  );

  expect(headers.get('tailscale-user-login')).toBe('alice@example.com');
  expect(headers.get('cookie')).toBe('a=1');
  expect(headers.get(PEER_HEADER)).toBeNull();
});

test('it routes the Host-named imp on the proxy port', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: { '/*': () => new Response('imp') },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
    headers: { host: 'web.imp.localhost' },
  });

  const body = await response.text();

  expect(body).toBe('imp');
});

test('it answers a Host that names no imp on the proxy port with a 404 that says how', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
    headers: { host: 'localhost' },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude(`Use http://&lt;imp&gt;.imp.localhost:${String(ctx.config.proxyPort)}/.`);
});

test('it answers an imp that does not exist with a 404 that names it', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
    headers: { host: 'nope.imp.localhost' },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude('There is no imp named nope.');
});

test('it answers an imp that cannot wake with a 503 that names the reason', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await ctx.impd.imps.stopImp('web');
  await proxy.syncListeners();

  ctx.fake.queue('boot', 'fail');

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);
  const body = await response.text();

  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBeNull();
  expect(body).toInclude('web could not wake: boot failed: no agent');
});

test('it answers a public request for an imp that cannot wake with a 503 that names nothing', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  await ctx.impd.imps.createImp({ name: 'web' });
  await ctx.impd.imps.stopImp('web');

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({
      kind: 'imp',
      name: 'web',
      public: { dropAuthorization: true, release: () => {} },
    }),
  });

  ctx.stack.defer(() => listener.stop(true));
  ctx.fake.queue('boot', 'fail');

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);
  const body = await response.text();

  expect(response.status).toBe(503);
  expect(body).toInclude('This site is not available right now.');
  expect(body).not.toInclude('web');
});

test('it answers an unauthorized route with a 401 and its challenge', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'unauthorized', challenge: 'Bearer realm="web", charset="UTF-8"' }),
  });

  ctx.stack.defer(() => listener.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);

  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer realm="web", charset="UTF-8"');
});

test('it answers a limited route with a 429 and its Retry-After', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'limited', detail: 'Too many open requests.', retryAfterS: 7 }),
  });

  ctx.stack.defer(() => listener.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
});

test('it wakes a sleeping imp and says how long the wake took', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: { '/*': () => new Response('imp') },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const logs = captureImpdLogs();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await ctx.impd.imps.sleepImp('web');
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/a`);

  await response.text();

  expect(response.headers.get('x-imp-wake-ms')).toMatch(/^\d+$/v);

  expect(logs).toContain(
    `INFO impd.proxy imp=web woke in ${String(response.headers.get('x-imp-wake-ms'))}ms for GET /a`,
  );
});

test('it stops the request to the imp when the client goes away', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const reached = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();

  onTestFinished(() => {
    aborted.resolve();
  });

  const handleUpstreamRequest = async (request: Request) => {
    request.signal.addEventListener('abort', () => {
      aborted.resolve();
    });

    reached.resolve(request.signal);

    await aborted.promise;

    return new Response('late');
  };

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleUpstreamRequest,
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const client = new AbortController();

  const url = `http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/slow`;
  const pending = Promise.allSettled([fetch(url, { signal: client.signal })]);

  const upstreamSignal = await reached.promise;

  client.abort();

  await waitFor(() => {
    expect(upstreamSignal.aborted).toBeTrue();
  });

  const settled = await pending;

  expect(settled).toStrictEqual([
    {
      status: 'rejected',
      reason: expect.toSatisfy(
        (reason: unknown) => reason instanceof Error && reason.name === 'AbortError',
      ),
    },
  ]);
});

// Bun prints a response body's unhandled error to the process's stderr, out
// of reach of the test runner, so the proxy runs in a child Bun whose stderr
// the test reads
test('it logs one impd.proxy line that names the imp, and nothing unhandled, when the imp’s server closes a stream', async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../../../testing/network/run-cut-proxied-stream.ts')],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  onTestFinished(() => {
    child.kill();
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  // an older Bun leaves the error's code out of a fetch error's message
  expect(stdout).toMatch(
    /^INFO impd\.proxy proxy on :\d+\nWARNING impd\.proxy imp=web the upstream closed GET \/rpc\/records\/follow mid-stream: (?:ECONNRESET: )?The socket connection was closed unexpectedly\. For more information, pass `verbose: true` in the second argument to fetch\(\)\n\{"client":"ECONNRESET"\}\n$/v,
  );

  expect(stderr).toBe('');
});

test('it warns through its logger, naming the imp, when the imp’s server closes a stream', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = startStubCutStream(ctx.stack, 'data: first\n\n');
  const warning = mock();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    logger: { warning },
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(
    `http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/rpc/records/follow`,
  );

  invariant(response.body);

  const reader = response.body.getReader();

  await reader.read();

  upstream.cut();

  await Promise.allSettled([reader.read()]);

  expect(warning).toHaveBeenCalledExactlyOnceWith(
    'the upstream closed {method} {path} mid-stream: {reason}',
    {
      imp: 'web',
      method: 'GET',
      path: '/rpc/records/follow',
      reason: expect.stringMatching(
        /^(?:ECONNRESET: )?The socket connection was closed unexpectedly\./v,
      ),
    },
  );
});

test('it keeps serving an imp after the imp’s server closes a stream', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = startStubCutStream(ctx.stack, 'data: first\n\n');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const url = `http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/rpc/records/follow`;

  const cutResponse = await fetch(url);

  invariant(cutResponse.body);

  const cutReader = cutResponse.body.getReader();

  await cutReader.read();

  upstream.cut();

  await Promise.allSettled([cutReader.read()]);

  const response = await fetch(url);

  invariant(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  // before the servers stop, or their reset of the answer goes unhandled
  ctx.stack.defer(() => reader.cancel());

  const first = await reader.read();

  expect(first.value).toBe('data: first\n\n');
});

test('it answers a 502 that names the port when nothing answers on the imp’s HTTP port', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: 1 });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  expect(response.status).toBe(502);

  const body = await response.text();

  expect(body).toInclude('web is awake, but nothing answered on port 1');
});

test('it answers a 502 when the imp’s WebSocket cannot be reached', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: 1 });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/socket`, {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',

      // any 16 bytes, base64
      'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    },
  });

  expect(response.status).toBe(502);

  const body = await response.text();

  expect(body).toInclude('The WebSocket to ws://127.0.0.1:1/socket failed: connection failed');
});

test('it answers a 502 when the imp’s WebSocket does not open in time', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const silent = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => {} },
  });

  ctx.stack.defer(() => {
    silent.stop(true);
  });

  const clock = buildStubClock();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
    upstreamSocketTimeoutMs: 50,
    startTimer: clock.startTimer,
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: silent.port });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const responding = fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/socket`, {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',

      // any 16 bytes, base64
      'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    },
  });

  await waitFor(() => {
    expect(clock.readPendingMs()).toStrictEqual([50]);
  });

  clock.firePending();

  const response = await responding;

  expect(response.status).toBe(502);

  const body = await response.text();

  expect(body).toInclude('failed: timed out');
});

test('it warns once about a slot whose port another process holds', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const squatter = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: { '/*': () => new Response('squatter') },
  });

  ctx.stack.defer(() => squatter.stop(true));

  const logs = captureImpdLogs();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => squatter.port ?? 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  await ctx.impd.imps.createImp({ name: 'first' });
  await proxy.syncListeners();
  await proxy.syncListeners();

  expect(logs.filter((line) => line.includes('cannot listen'))).toStrictEqual([
    expect.toStartWith(`WARNING impd.proxy cannot listen on :${String(squatter.port)} for first: `),
  ]);
});

test('it warns again about a slot that could not listen once a new imp holds it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const squatter = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    routes: { '/*': () => new Response('squatter') },
  });

  ctx.stack.defer(() => squatter.stop(true));

  const first = await ctx.impd.imps.createImp({ name: 'first' });

  const slotPorts = new Map([[first.slot, squatter.port ?? 0]]);

  const logs = captureImpdLogs();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: (slot) => slotPorts.get(slot) ?? 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  await proxy.syncListeners();

  await removeImp(ctx.db, first.id);

  await proxy.syncListeners();
  await ctx.impd.imps.createImp({ name: 'second' });
  await proxy.syncListeners();

  expect(logs.filter((line) => line.includes('cannot listen'))).toStrictEqual([
    expect.toStartWith(`WARNING impd.proxy cannot listen on :${String(squatter.port)} for first: `),
    expect.toStartWith(
      `WARNING impd.proxy cannot listen on :${String(squatter.port)} for second: `,
    ),
  ]);
});

test('it answers a request to a moving imp with a 503 and Retry-After', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await ctx.impd.imps.stopImp('web');

  await updateImpMove(ctx.db, imp.id, 'sending');

  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('30');
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../../src/config';
import { createDockerProxy } from '../../src/imps/docker-proxy/proxy';
import { buildActivityTracker } from '../../src/imps/imps/activity-tracker';
import { createForwardedPeers } from '../../src/network/proxy/forwarded-peers';
import { startWakeProxy } from '../../src/network/proxy/wake-proxy';
import { openDatabase } from '../../src/platform/db/open-database';
import { sendLongRequest } from '../../src/platform/process/send-long-request';

const ArgsSchema = z.discriminatedUnion('via', [
  z.object({ via: z.enum(['long-request', 'wake-proxy']), origin: z.url() }),
  z.object({ via: z.literal('docker-proxy'), socket: z.string() }),
]);

const args = ArgsSchema.parse(JSON.parse(process.argv[2] ?? ''));

function print(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function readErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function runCall(kind: string, send: () => Promise<Response>): Promise<void> {
  try {
    const response = await send();

    print({ kind, isOk: true, status: response.status, body: await response.text() });
  } catch (error) {
    process.stderr.write(`${kind}: ${String(error)}\n`);

    print({ kind, isOk: false, error: readErrorName(error) });
  }
}

async function startProxy(stack: Readonly<AsyncDisposableStack>, origin: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'idle-limited-proxy-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the origin's free port may fall in the imp ports, which a config refuses
  const config = {
    ...loadConfig({ IMP_DATA_DIR: dataDir }),
    apiPort: Number(new URL(origin).port),
  };

  // only an imp route wakes an imp; this one routes to the API alone
  const proxy = startWakeProxy({
    config,
    db,
    imps: {
      requireRunning: () => Promise.reject(new Error('no imp behind this proxy')),
      tracker: buildActivityTracker(),
      recordActivity: () => Promise.resolve(),
    },
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  stack.defer(() => proxy.stop());

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  stack.defer(() => listener.stop(true));

  return `http://127.0.0.1:${String(listener.port)}`;
}

function makeDockerProxyCalls(socket: string): [string, () => Promise<Response>][] {
  const proxy = createDockerProxy({
    upstreamSocket: socket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',

    // no builder image puts the proxy in host isolation, which lets pulls through
    builderImage: null,
    buildContextMaxBytes: 1024 ** 2,
    log: () => {},
  });

  return [
    [
      'pull',
      () =>
        proxy(
          new Request('http://docker/v1.55/images/create?fromImage=busybox&tag=latest', {
            method: 'POST',
          }),
        ),
    ],
    ['export', () => proxy(new Request(`http://docker/v1.55/containers/${'a'.repeat(64)}/export`))],
    [
      'control',
      () =>
        fetch('http://docker/control', { method: 'POST', body: 'the control call', unix: socket }),
    ],
  ];
}

const stack = new AsyncDisposableStack();

function makeCalls(): [string, () => Promise<Response>][] {
  if (args.via === 'docker-proxy') {
    return makeDockerProxyCalls(args.socket);
  }

  const origin = args.origin;

  const sendLong =
    args.via === 'long-request'
      ? () =>
          sendLongRequest(
            `${origin}/long`,
            { method: 'POST', body: 'the long call' },
            { deadline: null },
          )
      : async () => {
          const proxy = await startProxy(stack, origin);

          // this hop lifts its own limit, so only the proxy's hop is under test
          return fetch(`${proxy}/long`, { method: 'POST', body: 'the long call', timeout: false });
        };

  return [
    ['long', sendLong],
    ['control', () => fetch(`${origin}/control`, { method: 'POST', body: 'the control call' })],
  ];
}

await Promise.all(makeCalls().map(([kind, send]) => runCall(kind, send)));
await stack.disposeAsync();

process.exit(0);

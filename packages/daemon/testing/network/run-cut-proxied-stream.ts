// A child Bun that streams the imp `web` through the wake proxy, with impd's
// log on stdout, then cuts the stream at the imp's server. Stderr shows what
// Bun printed unhandled; stdout ends with the client's outcome as JSON.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';
import { openDatabase } from '../../src/db/open-database';
import { buildActivityTracker } from '../../src/imps/activity-tracker';
import { getImpdLogger } from '../../src/process/get-impd-logger';
import { setupLogging } from '../../src/process/setup-logging';
import { createForwardedPeers } from '../../src/proxy/forwarded-peers';
import { startWakeProxy } from '../../src/proxy/wake-proxy';
import { buildMockImpRecord } from '../imps/build-mock-imp-record';
import { startStubCutStream } from './start-stub-cut-stream';

setupLogging();

const stack = new AsyncDisposableStack();

const dataDir = await mkdtemp(join(tmpdir(), 'cut-proxied-stream-'));

stack.defer(() => rm(dataDir, { recursive: true, force: true }));

const db = await openDatabase(':memory:');

stack.defer(() => db.destroy());

const upstream = startStubCutStream(stack, 'data: first\n\n');
const imp = buildMockImpRecord({ name: 'web', ip: '127.0.0.1', httpPort: upstream.port });

const proxy = startWakeProxy({
  config: loadConfig({ IMP_DATA_DIR: dataDir }),
  db,
  imps: {
    requireRunning: () => Promise.resolve({ imp, wokeMs: null }),
    tracker: buildActivityTracker(),
    recordActivity: () => Promise.resolve(),
  },
  log: () => {},
  logger: getImpdLogger('proxy'),
  peers: createForwardedPeers(Date.now),
  ports: { proxy: 0, slot: () => 0 },
});

stack.defer(() => proxy.stop());

const listener = proxy.startListener({
  port: 0,
  hostname: '127.0.0.1',
  route: () => ({ kind: 'imp', name: 'web' }),
});

stack.defer(() => listener.stop(true));

const response = await fetch(`http://127.0.0.1:${String(listener.port)}/rpc/records/follow`);

const reader = response.body?.getReader();

await reader?.read();

upstream.cut();

const outcome = await reader?.read().then(
  () => 'more',
  (error: unknown) => (error instanceof Error && 'code' in error ? error.code : String(error)),
);

process.stdout.write(`${JSON.stringify({ client: outcome })}\n`);

await stack.disposeAsync();

process.exit(0);

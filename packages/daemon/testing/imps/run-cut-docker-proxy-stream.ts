import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDockerProxy } from '../../src/imps/docker-proxy/proxy';
import { setupLogging } from '../../src/platform/process/setup-logging';
import { startStubCutStream } from '../network/start-stub-cut-stream';

setupLogging();

const stack = new AsyncDisposableStack();

const directory = await mkdtemp(join(tmpdir(), 'cut-docker-proxy-stream-'));

stack.defer(() => rm(directory, { recursive: true, force: true }));

const engineSocket = join(directory, 'engine.sock');

const engine = startStubCutStream(stack, '{"status":"Pulling from library/busybox"}\n', {
  unix: engineSocket,
});

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  fetch: createDockerProxy({
    upstreamSocket: engineSocket,
    token: 'test-token',
    hostImage: 'ghcr.io/zgeoff/imp-host:latest',
    builderImage: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    log: () => {},
  }),
});

stack.defer(() => server.stop(true));

const response = await fetch(
  `http://127.0.0.1:${String(server.port)}/v1.55/images/create?fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`,
  { method: 'POST' },
);

const reader = response.body?.getReader();

await reader?.read();

engine.cut();

const outcome = await reader?.read().then(
  () => 'more',
  (error: unknown) => (error instanceof Error && 'code' in error ? error.code : String(error)),
);

process.stdout.write(`${JSON.stringify({ client: outcome })}\n`);

await stack.disposeAsync();

process.exit(0);

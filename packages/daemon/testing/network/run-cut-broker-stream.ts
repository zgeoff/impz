import { createForwarder } from '../../src/network/broker/tls/forward-request';
import { setupLogging } from '../../src/platform/process/setup-logging';
import { buildMockCredential } from './build-mock-credential';
import { startStubCutStream } from './start-stub-cut-stream';

setupLogging();

const stack = new AsyncDisposableStack();

const upstream = startStubCutStream(stack, 'data: first\n\n');

const forward = createForwarder({
  impId: 'imp-1',
  impName: 'web',
  host: 'api.example.com',
  findCredential: () =>
    Promise.resolve(
      buildMockCredential({ secretName: 'example', header: 'authorization', value: 'Bearer real' }),
    ),
  resolveUpstream: () => ({ origin: `http://127.0.0.1:${String(upstream.port)}`, ca: null }),
  recordAudit: () => {},
});

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: forward });

stack.defer(() => server.stop(true));

const response = await fetch(`http://127.0.0.1:${String(server.port)}/v1/events`, {
  headers: { host: 'api.example.com' },
});

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

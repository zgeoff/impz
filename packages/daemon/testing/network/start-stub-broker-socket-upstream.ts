import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { loadOrCreateBrokerCa } from '../../src/network/broker/tls/broker-ca';

interface StubSocketUpstreamOptions {
  readonly directory: string;
  readonly upgradeHeaders?: Readonly<Record<string, string>>;
}

interface SeenUpgrade {
  readonly path: string;
  readonly authorization: string | null;
  readonly protocols: string | null;
}

// A WebSocket service over real TLS with a CA of its own: it echoes each
// message and picks the first subprotocol a client offers.
export async function startStubBrokerSocketUpstream(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubSocketUpstreamOptions>,
) {
  const ca = await loadOrCreateBrokerCa(join(options.directory, 'stub-socket-upstream-ca'));
  const leaf = await ca.issueLeaf('localhost');

  const upgrades: SeenUpgrade[] = [];
  const received: (string | Buffer)[] = [];
  const sockets: ServerWebSocket[] = [];
  const closes: { code: number; reason: string }[] = [];

  const answerUpgrade = (request: Request, upgrading: Server<undefined>): Response | undefined => {
    const offered = request.headers.get('sec-websocket-protocol');

    upgrades.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
      protocols: offered,
    });

    const picked = offered?.split(',')[0]?.trim() ?? '';

    const isUpgraded = upgrading.upgrade(request, {
      data: undefined,
      headers: new Headers({
        ...options.upgradeHeaders,
        ...(picked !== '' && { 'sec-websocket-protocol': picked }),
      }),
    });

    return isUpgraded ? undefined : new Response('not a websocket', { status: 400 });
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch: answerUpgrade,
    websocket: {
      open: (ws) => {
        sockets.push(ws);
      },
      message: (ws, message) => {
        received.push(message);
        ws.send(message);
      },
      close: (_ws, code, reason) => {
        closes.push({ code, reason });
      },
    },
  });

  stack.defer(() => server.stop(true));

  const port = server.port ?? 0;

  return {
    port,
    origin: `https://localhost:${String(port)}`,
    caPem: ca.certPem,
    upgrades,
    received,
    sockets,
    closes,
  };
}

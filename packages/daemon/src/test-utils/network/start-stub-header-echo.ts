export function startStubHeaderEcho(stack: Readonly<AsyncDisposableStack>): {
  readonly port: number;
} {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: handleRequest,
    websocket: {
      message: (ws, message) => {
        ws.send(message);
      },
    },
  });

  stack.defer(() => server.stop(true));

  if (server.port === undefined) {
    throw new Error('the header echo has no port');
  }

  return { port: server.port };
}

interface HeaderEcho {
  readonly path: string;
  readonly proto: string | null;
  readonly host: string;
  readonly cookie: string | null;
  readonly authorization: string | null;
  readonly forwardedFor: string | null;
  readonly forwarded: string | null;
  readonly realIp: string | null;
  readonly forwardedHost: string | null;
}

function handleRequest(request: Request, upgrader: Bun.Server<undefined>) {
  if (request.headers.get('upgrade') === 'websocket') {
    return upgrader.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
  }

  const url = new URL(request.url);

  const echo: HeaderEcho = {
    path: url.pathname,
    proto: request.headers.get('x-forwarded-proto'),
    host: url.host,
    cookie: request.headers.get('cookie'),
    authorization: request.headers.get('authorization'),
    forwardedFor: request.headers.get('x-forwarded-for'),
    forwarded: request.headers.get('forwarded'),
    realIp: request.headers.get('x-real-ip'),
    forwardedHost: request.headers.get('x-forwarded-host'),
  };

  return Response.json(echo);
}

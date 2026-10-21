export function startStubSilentHost(stack: Readonly<AsyncDisposableStack>) {
  const requests: string[] = [];

  const handleRequest = (request: Request) => {
    requests.push(new URL(request.url).pathname);

    return new Promise<Response>(() => {
      // never answers
    });
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,

    // a stall outlasts any client deadline under test
    idleTimeout: 0,
    fetch: handleRequest,
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}`, requests };
}

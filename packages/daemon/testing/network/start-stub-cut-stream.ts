export function startStubCutStream(stack: Readonly<AsyncDisposableStack>, firstLine: string) {
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const handleRequest = () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        open.add(controller);
        controller.enqueue(new TextEncoder().encode(firstLine));
      },
    });

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: handleRequest,
  });

  stack.defer(() => server.stop(true));

  return {
    port: server.port ?? 0,
    cut: () => {
      for (const controller of open) {
        // Given no reason, Bun resets the connection and prints nothing.
        controller.error();
      }

      open.clear();
    },
  };
}

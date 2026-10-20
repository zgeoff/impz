// An imp's streaming HTTP server: each answer sends its first line and holds
// until cut() resets every answer still open, as a server that exits does.
// An answer that starts after a cut holds until the next one.
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
        // with no reason, Bun resets the connection and prints nothing
        controller.error();
      }

      open.clear();
    },
  };
}

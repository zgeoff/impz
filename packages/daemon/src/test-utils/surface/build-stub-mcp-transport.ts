import type { HttpTransport } from '@impz/mcp';

interface StubMcpCall {
  readonly request: Request;
  readonly end: () => void;
}

export function buildStubMcpTransport(
  options: Readonly<{
    failure?: Error;
  }> = {},
) {
  const calls: StubMcpCall[] = [];

  const callEnds = new WeakMap<Response, Promise<void>>();

  const state = { closes: 0 };

  const transport: HttpTransport = {
    respond: (request) => {
      if (options.failure !== undefined) {
        return Promise.reject(options.failure);
      }

      const ended = Promise.withResolvers<void>();

      const response = new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });

      callEnds.set(response, ended.promise);
      calls.push({ request, end: ended.resolve });

      return Promise.resolve(response);
    },
    close: () => {
      state.closes += 1;

      return Promise.resolve();
    },
    readCallEnd: (response) => callEnds.get(response) ?? null,
  };

  return {
    ...transport,
    calls,
    get closes(): number {
      return state.closes;
    },
  };
}

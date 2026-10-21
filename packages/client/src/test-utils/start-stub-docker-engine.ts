import { onTestFinished } from 'bun:test';

interface StubDockerEngineOptions {
  readonly socketPath: string;
  readonly imageId: string;
  readonly holdUntil?: () => Promise<void>;
  readonly failure?: string;
}

export function startStubDockerEngine(options: StubDockerEngineOptions) {
  const contexts: Uint8Array[] = [];
  const signals: AbortSignal[] = [];
  const unexpected: string[] = [];

  const handleRequest = async (request: Request) => {
    const call = `${request.method} ${new URL(request.url).pathname}`;

    if (call !== 'POST /build') {
      unexpected.push(call);

      return Response.json(
        { message: `stub docker engine: ${call} is not modelled` },
        { status: 500 },
      );
    }

    signals.push(request.signal);

    const context = await request.bytes();

    contexts.push(context);

    const answer = new ReadableStream<string>({
      start: async (controller) => {
        controller.enqueue(`${JSON.stringify({ id: 'moby.buildkit.trace', aux: 'CgQ=' })}\n`);

        await options.holdUntil?.();

        const last =
          options.failure === undefined
            ? { id: 'moby.image.id', aux: { ID: options.imageId } }
            : { errorDetail: { message: options.failure }, error: options.failure };

        controller.enqueue(`${JSON.stringify(last)}\n`);
        controller.close();
      },
    });

    return new Response(answer.pipeThrough(new TextEncoderStream()), {
      headers: { 'content-type': 'application/json' },
    });
  };

  // a held build stays open however long it is silent, as docker keeps it;
  // Bun's types leave idleTimeout off unix servers, but it applies there too
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const server = Bun.serve({
    unix: options.socketPath,
    idleTimeout: 0,
    fetch: handleRequest,
  } as unknown as Bun.Serve.Options<undefined>);

  onTestFinished(() => server.stop(true));

  return { contexts, signals, unexpected };
}

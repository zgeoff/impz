interface SilentOriginOptions {
  readonly controlPath?: string;
  readonly answer?: () => Response;
  readonly answerAtOnce?: (request: Request) => Response | null;
  readonly unix?: string;
}

export function startStubSilentOrigin(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<SilentOriginOptions> = {},
) {
  const controlPath = options.controlPath ?? '/control';
  const answerLong = options.answer ?? (() => new Response('the long answer'));
  const answerAtOnce = options.answerAtOnce ?? (() => null);
  const controlGone = Promise.withResolvers<void>();
  const longGone = Promise.withResolvers<void>();
  const controlHeld = Promise.withResolvers<void>();
  const longHeld = Promise.withResolvers<void>();

  const sendAnswer = async (request: Request): Promise<Response> => {
    await request.text();

    const isControl = new URL(request.url).pathname === controlPath;
    const atOnce = isControl ? null : answerAtOnce(request);

    if (atOnce !== null) {
      return atOnce;
    }

    const gone = isControl ? controlGone : longGone;
    const held = isControl ? controlHeld : longHeld;

    held.resolve();

    request.signal.addEventListener('abort', () => {
      gone.resolve();
    });

    await controlGone.promise;

    return isControl ? new Response('too late') : answerLong();
  };

  // Bun's types leave idleTimeout off unix servers, but Bun applies it there
  // too.
  const listen =
    options.unix === undefined ? { port: 0, hostname: '127.0.0.1' } : { unix: options.unix };

  const server = Bun.serve({
    ...listen,
    idleTimeout: 0,
    fetch: sendAnswer,
  } as unknown as Bun.Serve.Options<undefined>);

  stack.defer(() => server.stop(true));

  return {
    origin:
      options.unix === undefined ? `http://127.0.0.1:${String(server.port)}` : 'http://docker',
    controlHeld: controlHeld.promise,
    longHeld: longHeld.promise,
    controlGone: controlGone.promise,
    longGone: longGone.promise,
  };
}

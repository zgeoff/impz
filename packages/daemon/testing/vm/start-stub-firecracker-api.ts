import { onTestFinished } from 'bun:test';

interface StubFirecrackerAnswer {
  readonly status: number;

  readonly body?: unknown;
}

interface StubFirecrackerApiOptions {
  readonly answers?: Readonly<Record<string, StubFirecrackerAnswer>>;

  readonly isWedged?: boolean;
}

interface StubFirecrackerCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export function startStubFirecrackerApi(
  socketPath: string,
  options: Readonly<StubFirecrackerApiOptions> = {},
) {
  const calls: StubFirecrackerCall[] = [];

  const handleRequest = async (request: Request) => {
    const path = new URL(request.url).pathname;

    const text = await request.text();

    calls.push({ method: request.method, path, body: text === '' ? null : JSON.parse(text) });

    if (options.isWedged === true) {
      return new Promise<Response>(() => {});
    }

    const answer = options.answers?.[`${request.method} ${path}`];

    if (answer === undefined && request.method === 'GET') {
      return Response.json({}, { status: 200 });
    }

    if (answer === undefined) {
      return new Response(null, { status: 204 });
    }

    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);

    return new Response(body, { status: answer.status });
  };

  const server = Bun.serve({
    unix: socketPath,
    fetch: handleRequest,
  });

  onTestFinished(() => server.stop(true));

  return { calls };
}

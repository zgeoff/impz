import { onTestFinished } from 'bun:test';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';

interface StubPeerAnswer {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface ReceivedPeerRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

// A move target of any version, older ones included: each path answers with a
// fixed status and body, and a path left out answers 404 as an older target does.
export function startStubMovePeer(answers: Readonly<Record<string, StubPeerAnswer>>) {
  const received: ReceivedPeerRequest[] = [];

  const handleRequest = async (request: Request) => {
    const path = new URL(request.url).pathname;

    received.push({
      method: request.method,
      path,
      authorization: request.headers.get('authorization'),
      contentType: request.headers.get('content-type'),
      body: await request.text(),
    });

    const answer = answers[path];

    if (answer === undefined) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    return Response.json(answer.body, {
      status: answer.status ?? 200,
      headers: { ...answer.headers },
    });
  };

  const releases: (() => void)[] = [];
  const port = claimFreePorts(1, { onRelease: (release) => releases.push(release) }).take();
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handleRequest });

  onTestFinished(async () => {
    await server.stop(true);

    for (const release of releases) {
      release();
    }
  });

  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    stop: () => server.stop(true),
  };
}

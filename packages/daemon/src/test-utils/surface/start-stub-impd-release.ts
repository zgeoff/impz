import { buildStubImpdReleaseFetch } from './build-stub-impd-release-fetch';
import type { StubImpdReleaseOptions } from './build-stub-impd-release-fetch';

export function startStubImpdRelease(
  stack: Readonly<AsyncDisposableStack>,
  fetch: (request: Request) => Promise<Response>,
  options: Readonly<StubImpdReleaseOptions> = {},
) {
  const release = buildStubImpdReleaseFetch(fetch, options);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: release.fetch,
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}`, calls: release.calls };
}

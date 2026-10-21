import { IMAGE_BUILD_PATH } from '@impz/api';

export function buildStubImpdBeforeBuildStream(
  handle: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => {
    if (new URL(request.url).pathname !== IMAGE_BUILD_PATH) {
      return handle(request);
    }

    const headers = new Headers(request.headers);

    headers.delete('accept');

    // `duplex` is in the fetch spec, but not in every RequestInit type.
    const init: RequestInit & { readonly duplex: 'half' } = {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      duplex: 'half',
    };

    return handle(new Request(request.url, init));
  };
}

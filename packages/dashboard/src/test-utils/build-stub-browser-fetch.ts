type Fetch = typeof fetch;

type SendRequest = (input: Parameters<Fetch>[0], init?: BunFetchRequestInit) => Promise<Response>;

// Bun's fetch never sends `Sec-Fetch-Site`, which a browser sets to
// `same-origin` on a request to the page's own origin
export function buildStubBrowserFetch(innerFetch: Fetch, pageUrl: string): Fetch {
  const pageOrigin = new URL(pageUrl).origin;

  const sendRequest: SendRequest = (input, init) => {
    const target = input instanceof Request ? input : new URL(input.toString(), pageUrl);

    const request = new Request(target, init);

    if (new URL(request.url).origin === pageOrigin) {
      request.headers.set('sec-fetch-site', 'same-origin');
    }

    return innerFetch(request);
  };

  return Object.assign(sendRequest, { preconnect: innerFetch.preconnect });
}

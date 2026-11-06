import { isLoopbackHost } from './is-loopback-host';

type Fetch = typeof fetch;

type SendRequest = (input: Parameters<Fetch>[0], init?: BunFetchRequestInit) => Promise<Response>;

// MSW rebuilds a request it lets through and drops Bun's own `unix` and `tls`
// options, so a unix-socket or loopback request skips MSW for the native fetch.
export function buildRoutedFetch(nativeFetch: Fetch, mockedFetch: Fetch): Fetch {
  const sendRequest: SendRequest = (input, init) => {
    const href = input instanceof Request ? input.url : input.toString();
    const isLocal = init?.unix !== undefined || (URL.canParse(href) && isLoopbackHost(href));

    if (isLocal) {
      return nativeFetch(input, init);
    }

    return mockedFetch(input, init);
  };

  return Object.assign(sendRequest, { preconnect: nativeFetch.preconnect });
}

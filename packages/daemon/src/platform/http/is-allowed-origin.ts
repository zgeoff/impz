import { match } from 'ts-pattern';
import { parseRequestOrigin } from './parse-request-origin';
import type { RequestOrigin } from './parse-request-origin';

export type OriginPolicy =
  | { readonly kind: 'same-origin' }
  | { readonly kind: 'browser-same-origin' }
  | { readonly kind: 'ambient' }
  | { readonly kind: 'same-origin-form'; readonly origin: string }
  | { readonly kind: 'public-route'; readonly origin: string };

export function isAllowedOrigin(request: Request, policy: OriginPolicy): boolean {
  const from = parseRequestOrigin(request);

  return match(policy)
    .with({ kind: 'same-origin' }, () => isSameOrigin(from, request))
    .with({ kind: 'browser-same-origin' }, () => !from.fromBrowser || isSameOrigin(from, request))
    .with({ kind: 'ambient' }, () => isAmbientOrigin(from, request))
    .with(
      { kind: 'same-origin-form' },
      (form) =>
        from.origin === form.origin || (from.origin === 'null' && from.site === 'same-origin'),
    )
    .with(
      { kind: 'public-route' },
      (route) =>
        !from.fromBrowser ||
        (from.origin === route.origin && (from.site === null || from.site === 'same-origin')),
    )
    .exhaustive();
}

function isSameOrigin(from: RequestOrigin, request: Request): boolean {
  if (from.site !== null) {
    return from.site === 'same-origin';
  }

  // host and port only (Bun builds the request URL from the Host header): a
  // TLS front such as tailscale serve talks plain HTTP to impd, so the scheme
  // the browser saw is not the one impd sees
  return from.origin !== null && isOriginHost(from.origin, new URL(request.url).host);
}

function isOriginHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function isAmbientOrigin(from: RequestOrigin, request: Request): boolean {
  // `none` is a navigation the user typed
  if (from.site !== null && from.site !== 'same-origin' && from.site !== 'none') {
    return false;
  }

  return (
    from.origin === null ||
    isOriginHost(from.origin, request.headers.get('host')?.toLowerCase() ?? '')
  );
}

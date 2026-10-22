type Route =
  | { readonly kind: 'ping' }
  | { readonly kind: 'version' }
  | { readonly kind: 'image-inspect'; readonly name: string }
  | { readonly kind: 'pull' }
  | { readonly kind: 'build' }
  | { readonly kind: 'create' }
  | { readonly kind: 'export'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string };

export interface RoutedRequest {
  readonly versionPrefix: string;
  readonly route: Route;
  readonly query: ReadonlyMap<string, readonly string[]>;
}

export type RouteResult =
  | { readonly isAllowed: true; readonly request: RoutedRequest }
  | { readonly isAllowed: false; readonly reason: string };

const VERSION_PREFIX = /^\/v1\.\d{1,3}(?=\/)/v;
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/:@\-]*$/v;
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/v;

/* @internal */
export function parseQuery(raw: string): ReadonlyMap<string, readonly string[]> {
  const query = new Map<string, string[]>();

  for (const [key, value] of new URLSearchParams(raw)) {
    query.set(key, [...(query.get(key) ?? []), value]);
  }

  return query;
}

export function formatQuery(query: ReadonlyMap<string, readonly string[]>): string {
  const params = new URLSearchParams();

  for (const [key, values] of query) {
    for (const value of values) {
      params.append(key, value);
    }
  }

  return params.size === 0 ? '' : `?${params.toString()}`;
}

function buildRefusal(reason: string): RouteResult {
  return { isAllowed: false, reason };
}

function findRoute(method: string, path: string): Route | null {
  if (path === '/_ping' && (method === 'GET' || method === 'HEAD')) {
    return { kind: 'ping' };
  }

  if (path === '/version' && method === 'GET') {
    return { kind: 'version' };
  }

  if (method === 'POST') {
    if (path === '/images/create') {
      return { kind: 'pull' };
    }

    if (path === '/build') {
      return { kind: 'build' };
    }

    if (path === '/containers/create') {
      return { kind: 'create' };
    }

    return null;
  }

  const image = /^\/images\/(?<name>.+)\/json$/v.exec(path)?.groups?.['name'];

  if (method === 'GET' && image !== undefined && IMAGE_NAME.test(image)) {
    return { kind: 'image-inspect', name: image };
  }

  const exported = /^\/containers\/(?<id>[^\/]+)\/export$/v.exec(path)?.groups?.['id'];

  if (method === 'GET' && exported !== undefined && CONTAINER_ID.test(exported)) {
    return { kind: 'export', id: exported };
  }

  const removed = /^\/containers\/(?<id>[^\/]+)$/v.exec(path)?.groups?.['id'];

  if (method === 'DELETE' && removed !== undefined && CONTAINER_ID.test(removed)) {
    return { kind: 'remove', id: removed };
  }

  return null;
}

// `target` stays undecoded, and Bun's URL parser has already resolved its dot segments and `\`.
export function getRequestRoute(method: string, target: string): RouteResult {
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : target.slice(queryStart + 1);

  if (!rawPath.startsWith('/') || /%|\\|\/\/|\/\.\.?(?:\/|$)/v.test(rawPath)) {
    return buildRefusal(`path ${JSON.stringify(rawPath)} is not a plain path`);
  }

  const versionPrefix = VERSION_PREFIX.exec(rawPath)?.[0] ?? '';
  const path = rawPath.slice(versionPrefix.length);
  const route = findRoute(method, path);

  if (route === null) {
    return buildRefusal(`${method} ${path} is not a call impd makes`);
  }

  return { isAllowed: true, request: { versionPrefix, route, query: parseQuery(rawQuery) } };
}

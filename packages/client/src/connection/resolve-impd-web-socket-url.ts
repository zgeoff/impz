import { resolveImpdUrl } from './resolve-impd-url';

export function resolveImpdWebSocketUrl(base: string, path: string): URL {
  const url = resolveImpdUrl(base, path);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url;
}

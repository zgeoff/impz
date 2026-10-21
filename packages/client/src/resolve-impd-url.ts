export function resolveImpdUrl(base: string, path: string): URL {
  const url = new URL(base);

  // `new URL(path, base)` would drop a path prefix that a reverse proxy may need.
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`;

  return url;
}

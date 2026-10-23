export function normalizeHost(host: string | null): string | null {
  if (host === null || host.startsWith('[')) {
    return null;
  }

  return host.replace(/:\d+$/v, '').replace(/\.$/v, '').toLowerCase();
}

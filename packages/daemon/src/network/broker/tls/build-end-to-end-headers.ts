// Per RFC 9110 these describe one connection, not the message, and the proxy
// ones are the guest's to its proxy; this hop answers `expect` itself.
const HOP_HEADERS = [
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export function buildEndToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);

  const named = (source.get('connection') ?? '').split(',').map((name) => name.trim());

  for (const name of [...HOP_HEADERS, ...named]) {
    if (name !== '') {
      headers.delete(name);
    }
  }

  return headers;
}

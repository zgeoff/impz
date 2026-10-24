import type { AuditRefusal } from '@impz/api';

export const MAX_HEAD_BYTES = 8192;

export type ConnectHead =
  | { readonly kind: 'connect'; readonly host: string; readonly port: number }
  | {
      readonly kind: 'refused';
      readonly status: 400 | 405;
      readonly reason: string;

      readonly refusal: AuditRefusal;
      readonly method: string | null;
    };

const HEAD_END = '\r\n\r\n';

export function findHeadEnd(buffered: Uint8Array): number | null {
  const at = Buffer.from(buffered.buffer, buffered.byteOffset, buffered.byteLength).indexOf(
    HEAD_END,
  );

  return at === -1 ? null : at + HEAD_END.length;
}

export function parseConnectHead(head: string): ConnectHead {
  const line = head.slice(0, head.indexOf('\r\n'));
  const parts = line.split(' ');

  if (parts.length !== 3 || !(parts[2] ?? '').startsWith('HTTP/1.')) {
    return {
      kind: 'refused',
      status: 400,
      reason: 'not an HTTP/1 request',
      refusal: 'not-http',
      method: null,
    };
  }

  const [method = '', target = ''] = parts;

  if (method !== 'CONNECT') {
    return {
      kind: 'refused',
      status: 405,
      reason: 'only CONNECT is served',
      refusal: 'not-connect',
      method: buildAuditMethod(method),
    };
  }

  const match = /^(?:\[(?<v6>[0-9a-f:.]+)\]|(?<name>[a-z0-9.-]{1,253})):(?<port>\d{1,5})$/iu.exec(
    target,
  );

  const port = Number(match?.groups?.['port']);
  const host = match?.groups?.['v6'] ?? match?.groups?.['name'];

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      kind: 'refused',
      status: 400,
      reason: 'the target is not host:port',
      refusal: 'bad-target',
      method,
    };
  }

  return { kind: 'connect', host: host.toLowerCase(), port };
}

// a method token as RFC 9110 defines one
function buildAuditMethod(method: string): string | null {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,16}$/u.test(method) ? method : null;
}

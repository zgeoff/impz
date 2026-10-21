import { randomBytes } from 'node:crypto';
import { EXEC_PATH, MCP_PATH, TUNNEL_PATH } from '@impz/api';
import { createTtlCache } from '../../platform/process/ttl-cache';

// a random handle the API redeems once, not the address itself, which any
// client could write into a forwarded header
export const PEER_HEADER = 'x-imp-peer';
const HANDLE_TTL_MS = 30_000;
const MAX_HANDLES = 1024;

export interface ForwardedPeers {
  readonly register: (address: string) => string;

  readonly take: (handle: string) => string | null;
}

export function createForwardedPeers(now: () => number): ForwardedPeers {
  // lru-cache keeps an entry until its age passes the ttl, hence one ms less;
  // no read touches recency, so a full cache evicts the oldest handle
  const handles = createTtlCache<string, string>({
    max: MAX_HANDLES,
    ttlMs: HANDLE_TTL_MS - 1,
    now,
  });

  return {
    register: (address) => {
      handles.purgeStale();

      const handle = randomBytes(24).toString('base64url');

      handles.set(handle, address);

      return handle;
    },
    take: (handle) => {
      const address = handles.peek(handle);

      handles.delete(handle);

      return address ?? null;
    },
  };
}

export function isCallerPath(pathname: string): boolean {
  return (
    pathname.startsWith('/rpc/') ||
    pathname === EXEC_PATH ||
    pathname === TUNNEL_PATH ||
    pathname === MCP_PATH
  );
}

export function redeemPeerAddress(
  request: Request,
  socketAddress: string | null,
  peers: ForwardedPeers,
): string | null {
  if (socketAddress === null || !isLoopback(socketAddress)) {
    return socketAddress;
  }

  const handle = request.headers.get(PEER_HEADER);

  return handle === null ? socketAddress : (peers.take(handle) ?? socketAddress);
}

function isLoopback(address: string): boolean {
  return address === '::1' || /^(?:::ffff:)?127\./iu.test(address);
}

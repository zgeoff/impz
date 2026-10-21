import type { TailscaleStatus } from '../../host-net/net/tailscale-status';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export interface KnownHosts {
  readonly read: () => Promise<ReadonlySet<string>>;
}

interface KnownHostsDeps {
  readonly readTailscale: () => Promise<TailscaleStatus>;

  readonly domain: string | null;
}

export function createKnownHosts(deps: Readonly<KnownHostsDeps>): KnownHosts {
  return {
    read: async () => {
      const status = await deps.readTailscale();

      const addresses = status.ips.map(readAddressHost);
      const names = [...LOOPBACK_HOSTS, status.hostname, status.dnsName, ...addresses, deps.domain];

      return new Set(names.filter((name) => name !== null).map((name) => name.toLowerCase()));
    },
  };
}

export function isAllowedAmbientRequest(request: Request, hosts: ReadonlySet<string>): boolean {
  // a browser on a tailnet machine carries its identity on any page's request,
  // like a cookie, so the request must name a known host (DNS rebinding) and
  // come from impd's own origin, not an imp's port
  const host = findHostName(request.headers.get('host'));

  if (host === null || !hosts.has(host)) {
    return false;
  }

  const site = request.headers.get('sec-fetch-site');

  // `none` is a navigation the user typed
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return false;
  }

  // a client that is not a browser sends no Origin
  const origin = request.headers.get('origin');

  if (origin === null) {
    return true;
  }

  try {
    return new URL(origin).host === request.headers.get('host')?.toLowerCase();
  } catch {
    return false;
  }
}

function readAddressHost(ip: string): string | null {
  const host = ip.includes(':') ? `[${ip}]` : ip;

  return findHostName(host);
}

function findHostName(header: string | null): string | null {
  if (header === null || header === '') {
    return null;
  }

  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

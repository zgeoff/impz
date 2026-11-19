import type { TailscaleStatus } from '../../host-net/net/tailscale-status';
import { isAllowedOrigin } from '../../platform/http/is-allowed-origin';

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

  return host !== null && hosts.has(host) && isAllowedOrigin(request, { kind: 'ambient' });
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
